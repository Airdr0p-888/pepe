/* 青蛙铸造页（V3 引擎）
 * 铸造逻辑：V3 合约通过 mint(uint256 shares, address referrer, uint256 maxCost) payable 铸造，调用时附带等于单价的 BNB value。
 * 钱包：优先使用币安 Agentic Wallet 扫码（window.WCMint + Agentic API）。
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const BSC_CHAIN_ID = 56;
  // 只读 RPC（按可用性排序；币安种子节点在本环境会超时，优先用 publicnode）
  const READ_RPCS = [
    "https://bsc.publicnode.com",
    "https://rpc.ankr.com/bsc",
    "https://bsc-dataseed.binance.org/",
  ];
  const EXPLORER = "https://bscscan.com";

  /* V3 合约 ABI（与 11.4-v3 读取逻辑一致） */
  const V3_ABI = [
    "function mint(uint256 shares, address referrer, uint256 maxCost) payable",
    "function mintPrice() view returns (uint256)",
    "function totalSharesCap() view returns (uint256)",
    "function totalSharesMinted() view returns (uint256)",
    "function mintedShares(address) view returns (uint256)",
    "function agentIdNft() view returns (address)",
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function mintTokensPerShare() view returns (uint256)"
  ];
  const NFT_ABI = ["function balanceOf(address) view returns (uint256)"];
  const ZERO = "0x0000000000000000000000000000000000000000";
  let curPriceBnb = 0;

  let provider = null;     // 浏览器钱包 provider（已连接）
  let readProvider = null; // 只读 provider（未连钱包时也能读链上数据）
  let signer = null;
  let currentAccount = null;
  let contractAddr = "";
  let tokenContract = null;
  let meta = {
    name: "青蛙代币", symbol: "FROG", decimals: 18,
    price: 0n, max: 0n, mintAll: 0n, requiredNFT: ZERO,
    maxMint: 0n, start: 0n,
  };

  const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
  function readProv() {
    if (provider) return provider;
    if (!readProvider) {
      readProvider = new ethers.JsonRpcProvider(
        READ_RPCS[0],
        { chainId: 56, name: "bnb" },
        { staticNetwork: true, timeout: 20000 }
      );
    }
    return readProvider;
  }

  /* ---------- 提示 ---------- */
  let toastTimer = null;
  function showMsg(text, kind) {
    const el = $("mintStatus");
    if (el) {
      el.textContent = text;
      el.className = "status" + (kind ? " " + kind : "");
    }
    const t = $("toast");
    if (t) {
      t.textContent = text;
      t.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
    }
  }

  /* ---------- 青蛙马赛克漂浮背景（方块瓦片） ---------- */
  function initFrogBg() {
    const cv = $("frogBg");
    if (!cv) return;
    const ctx = cv.getContext("2d");
    let w, h, tiles;
    const colors = ["#7ee08f", "#c9ffb8", "#ffffff", "#bdf0c0", "#1b1b1b"];
    function resize() {
      w = cv.width = window.innerWidth;
      h = cv.height = window.innerHeight;
      const n = Math.min(46, Math.floor(w / 22));
      tiles = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        s: 12 + Math.random() * 30,
        sp: 0.2 + Math.random() * 0.7,
        dx: (Math.random() - 0.5) * 0.5,
        a: 0.10 + Math.random() * 0.18,
        c: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.012,
      }));
    }
    function draw() {
      ctx.clearRect(0, 0, w, h);
      for (const t of tiles) {
        t.y += t.sp; t.x += t.dx; t.rot += t.vr;
        if (t.y > h + 40) { t.y = -40; t.x = Math.random() * w; }
        if (t.x > w + 40) t.x = -40;
        if (t.x < -40) t.x = w + 40;
        ctx.save();
        ctx.globalAlpha = t.a;
        ctx.translate(t.x, t.y);
        ctx.rotate(t.rot);
        ctx.fillStyle = t.c;
        ctx.fillRect(-t.s / 2, -t.s / 2, t.s, t.s);
        ctx.strokeStyle = "rgba(0,0,0,0.18)";
        ctx.lineWidth = 1;
        ctx.strokeRect(-t.s / 2, -t.s / 2, t.s, t.s);
        ctx.restore();
      }
      requestAnimationFrame(draw);
    }
    resize();
    window.addEventListener("resize", resize);
    draw();
  }

  /* ---------- 网络 ---------- */
  async function ensureNetwork() {
    const eth = window.ethereum || window.BinanceChain;
    if (!eth) return;
    try {
      const cid = await eth.request({ method: "eth_chainId" });
      if (Number(cid) !== BSC_CHAIN_ID) {
        try {
          await eth.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x38" }],
          });
        } catch (_) { /* 用户拒绝或不支持，忽略 */ }
      }
    } catch (_) { /* 忽略 */ }
  }

  /* ---------- 连接钱包（扫码优先：Agentic Wallet / WalletConnect） ---------- */
  const WC_PID_KEY = "frog_wc_pid";
  const DEFAULT_WC_PID = "d1d20d01deca8b04d0c243954db38bd8"; // 11.3 同款默认 projectId
  const AGENTIC_RELAY = READ_RPCS; // 复用只读节点，供 Agentic 路由的 eth_call 等读取

  function wcProjectId() {
    return (localStorage.getItem(WC_PID_KEY) || DEFAULT_WC_PID).trim();
  }
  function agentApiUrl() {
    return (document.querySelector('meta[name="agent-wallet-api"]')?.content || "").trim().replace(/\/$/, "");
  }
  async function agentCall(action, extra = {}) {
    const r = await fetch(agentApiUrl(), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sessionId: agenticSession, ...extra }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const detail = (j && j.error) || r.statusText || "Agentic Wallet 请求失败";
      throw new Error(`[${r.status}] ${detail}（当前页面 Origin=${location.origin}）`);
    }
    return j;
  }
  function nested(obj, keys) {
    if (!obj || typeof obj !== "object") return null;
    for (const key of keys) if (typeof obj[key] === "string" && obj[key]) return obj[key];
    for (const value of Object.values(obj)) { const f = nested(value, keys); if (f) return f; }
    return null;
  }
  function saveAgenticLogin(o) { try { localStorage.setItem("agentic_login", JSON.stringify(o)); } catch {} }
  function clearAgenticLogin() { try { localStorage.removeItem("agentic_login"); } catch {} }
  function readAgenticLogin() { try { return JSON.parse(localStorage.getItem("agentic_login")); } catch { return null; } }

  async function rpcCall(method, params) {
    let lastMsg = "", lastData = "";
    for (const rpc of AGENTIC_RELAY) {
      try {
        const response = await fetch(rpc, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const json = await response.json();
        if (!json.error) return json.result;
        lastMsg = (json.error && json.error.message) || "";
        lastData = typeof (json.error && json.error.data) === "string" ? json.error.data : "";
        if (lastData) break;
      } catch (e) { lastMsg = String((e && e.message) || e); }
    }
    if (lastData) throw new Error("合约拒绝: " + lastData);
    if (/revert/i.test(lastMsg)) throw new Error("合约拒绝: " + lastMsg);
    throw new Error(method + " 请求失败: 公共节点不可用");
  }

  // EIP-6963 + 币安插件识别（只认币安钱包，避免误连 MetaMask）
  const eip6963 = [];
  window.addEventListener("eip6963:announceProvider", (e) => {
    if (e && e.detail && e.detail.info && e.detail.provider) eip6963.push(e.detail);
  });
  function inBinanceApp() {
    return /Binance|binancew3w|bnbweb3/i.test(navigator.userAgent) || !!(window.binancew3w);
  }
  function injectedWallet() {
    const binance = eip6963.filter((d) => String((d.info && d.info.rdns) || "").toLowerCase().includes("binance"));
    if (binance.length) return binance[0].provider;
    const e = window.ethereum;
    if (e && (e.isBinance || e.isBinanceWeb3Wallet || e.isBinanceW3W)) return e;
    if (window.BinanceChain) return window.BinanceChain;
    if (window.binancew3w && window.binancew3w.ethereum) return window.binancew3w.ethereum;
    if (inBinanceApp() && e) return e; // 币安 App 内置浏览器没打标记时的兜底
    return null;
  }

  let agenticSession = "";
  let qrAborted = false;
  let wcProvider = null;
  let agenticProvider = null;

  // Agentic 路由的签名器：把 eth_sendTransaction 转发给币安 Agentic 后端预览+执行
  function buildAgenticProvider(address) {
    const toHex = (v) =>
      typeof v === "bigint" ? "0x" + v.toString(16)
      : v == null ? "0x"
      : typeof v === "number" ? "0x" + v.toString(16)
      : String(v);
    return {
      async request({ method, params = [] }) {
        if (method === "eth_chainId") return "0x38";
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
        if (["eth_blockNumber", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_call", "eth_getBalance"].includes(method))
          return rpcCall(method, params);
        if (method === "eth_sendTransaction") {
          const tx = params[0];
          const preview = await agentCall("preview", {
            tx: { from: address, to: tx.to, value: tx.value ? toHex(tx.value) : "0x0", inputData: tx.data || "0x" },
          });
          const requestId = nested(preview.result, ["requestId"]);
          if (!requestId) throw new Error("交易预览未返回 requestId");
          const executed = await agentCall("execute", { requestId });
          const hash = nested(executed.result, ["txHash", "transactionHash", "hash"]);
          if (!hash) throw new Error("等待币安 App 确认交易");
          return hash;
        }
        if (method.startsWith("eth_")) return rpcCall(method, params);
        if (method.startsWith("wallet_")) return null; // 权限类查询，Agentic 不支持，返回空避免报错
        throw new Error("不支持的钱包方法: " + method);
      },
    };
  }

  // 把连接结果接入本页 provider/signer（铸造 / 查询通用）
  async function applyConnected(walletProv, address) {
    provider = new ethers.BrowserProvider(walletProv);
    signer = await provider.getSigner();
    currentAccount = address;
    $("connectBtn").textContent = shortAddr(address);
    $("topWallet").textContent = shortAddr(address);
    onAccountChanged(address);
    await ensureNetwork();
    if (contractAddr) loadInfo();
    showMsg("钱包已连接：" + address, "ok");
  }

  // 扫码是唯一默认入口：点「连接币安 AI 钱包」直接弹二维码
  // 站点域名已加入 Agentic 后端 Origin 白名单，优先走 Agentic Wallet 扫码；
  // 若后端偶发不可用，自动退化 WalletConnect 扫码（兜底）。
  function connect() {
    connectAgenticRoute();
  }

  async function connectBrowserWallet() {
    const w = injectedWallet() || (eip6963[0] && eip6963[0].provider) || window.ethereum;
    if (!w) {
      showMsg("未检测到浏览器钱包（币安 / TP / MetaMask 等）。请改用「Agentic Wallet 扫码」连接。", "err");
      return;
    }
    try {
      const accs = await w.request({ method: "eth_requestAccounts" });
      await applyConnected(w, accs[0]);
    } catch (e) { showMsg("连接失败：" + (e.message || e), "err"); }
  }

  // 默认且优先的扫码路线：有 Agentic API 先走 Agentic，失败则退化成 WalletConnect 扫码
  async function connectAgenticRoute() {
    if (agentApiUrl()) {
      try { await connectAgentic(); return; }
      catch (e) {
        console.error("[Agentic] 连接失败：", e);
        showMsg("Agentic 扫码失败（" + ((e && e.message) || e) + "），改用 WalletConnect…", "err");
      }
    }
    await connectWC();
  }

  async function connectAgentic() {
    try {
      qrAborted = false;
      showMsg("正在获取币安 Agentic Wallet 登录二维码…");
      const login = await agentCall("login");
      agenticSession = login.sessionId;
      const data = login.result || {};
      const url = nested(data, ["urlForWeb", "qrCodeUrl"]);
      const qrCodeId = nested(data, ["qrCodeId"]);
      const pair = nested(data, ["pairingCode"]);
      if (!url || !qrCodeId) throw new Error("未收到币安登录二维码");
      saveAgenticLogin({ sessionId: agenticSession, qrCodeId, url, pair });
      showAgenticQr({ url, pair });
      await waitAgenticConfirm(qrCodeId);
    } catch (e) {
      clearAgenticLogin(); closeQr();
      const msg = (e && e.message) || String(e);
      if (/load failed|failed to fetch|networkerror|network error/i.test(msg))
        showMsg("Agentic 服务当前环境无法访问，请改用 WalletConnect 扫码或浏览器钱包。", "err");
      else showMsg("Agentic Wallet 连接失败：" + msg, "err");
      throw e;
    }
  }

  async function waitAgenticConfirm(qrCodeId) {
    await agentCall("confirm", { qrCodeId });
    if (qrAborted) throw new Error("已取消登录");
    const wallet = await agentCall("wallet");
    const address = wallet.address;
    agenticProvider = buildAgenticProvider(address);
    closeQr();
    await applyConnected(agenticProvider, address);
  }

  function showAgenticQr({ url, pair }) {
    const box = $("qrBox");
    if (box) box.innerHTML = window.WCMint?.qrSvg ? window.WCMint.qrSvg(url) : url;
    if ($("qrMode")) $("qrMode").textContent = "用币安 App 扫码，核对配对码后确认登录。";
    if ($("awPair")) $("awPair").textContent = pair || "——";
    if ($("wcOpen")) { $("wcOpen").href = url; $("wcOpen").textContent = "打开币安登录"; }
    if ($("qrModal")) $("qrModal").classList.remove("hidden");
    if ($("awWait")) $("awWait").textContent = "等待币安 App 扫码并确认…";
  }

  // 手机从币安 App 返回后（即使标签页被重载）自动恢复登录态
  async function restoreAgenticSession() {
    if (!agentApiUrl() || provider || currentAccount) return;
    const saved = readAgenticLogin();
    if (!saved || !saved.sessionId || !saved.qrCodeId) return;
    agenticSession = saved.sessionId;
    showAgenticQr(saved);
    try { await waitAgenticConfirm(saved.qrCodeId); }
    catch (e) { if (!qrAborted) clearAgenticLogin(); closeQr(); showMsg("上次登录会话已失效，请重新点击「连接钱包」。", "err"); }
  }

  function wcOpenUrl(uri) { return "https://walletconnect.com/wc?uri=" + encodeURIComponent(uri); }
  function showQr(uri) {
    const ok = typeof uri === "string" && uri.indexOf("wc:") === 0;
    const box = $("qrBox");
    if (box) {
      if (ok && window.WCMint && window.WCMint.qrSvg) { try { box.innerHTML = window.WCMint.qrSvg(uri); } catch { box.textContent = uri; } }
      else box.innerHTML = `<span style="color:#ff8a8a">连接串异常（不是有效的 wc: 连接串）：<br>${String(uri).slice(0, 300)}</span>`;
    }
    if ($("wcOpen")) { $("wcOpen").href = ok ? wcOpenUrl(uri) : "#"; $("wcOpen").textContent = "打开币安 App"; }
    if ($("qrMode")) $("qrMode").textContent = ok ? "用币安 App 扫码，确认配对码一致后授权连接。" : "连接串异常";
    if ($("qrModal")) $("qrModal").classList.remove("hidden");
    const tm = ok ? uri.match(/^wc:([0-9a-fA-F]+)@/) : null;
    if ($("awPair")) $("awPair").textContent = tm ? tm[1].slice(0, 6).toUpperCase() : "——";
    if ($("awBadge")) { $("awBadge").textContent = "正在连接…"; $("awBadge").classList.remove("ok"); }
    startWaitTimer();
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && String(uri).startsWith("wc:")) {
      try { window.open(wcOpenUrl(uri), "_blank"); } catch {}
    }
  }
  function showUrlQr() {
    const url = location.href.split("#")[0];
    const box = $("qrBox");
    if (box) { try { box.innerHTML = window.WCMint && window.WCMint.qrSvg ? window.WCMint.qrSvg(url) : url; } catch { box.textContent = url; } }
    if ($("qrMode")) $("qrMode").textContent = "用币安 App 扫码 → 在 App 内打开本站 → App 内自带币安钱包，无需扫码连接。";
    if ($("awPair")) $("awPair").textContent = "——";
    if ($("wcOpen")) { $("wcOpen").href = url; $("wcOpen").textContent = "打开本站"; }
    if ($("qrModal")) $("qrModal").classList.remove("hidden");
    if ($("awBadge")) { $("awBadge").textContent = "正在连接…"; $("awBadge").classList.remove("ok"); }
    startWaitTimer();
  }
  let waitTimer = null, waitStart = 0;
  function startWaitTimer() {
    stopWaitTimer(); waitStart = Date.now();
    const el = $("awWait"); if (!el) return;
    const tick = () => { el.textContent = `等待币安 App 确认 · ${Math.floor((Date.now() - waitStart) / 1000)}s`; };
    tick(); waitTimer = setInterval(tick, 1000);
  }
  function stopWaitTimer() {
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
    const el = $("awWait"); if (el) el.textContent = "";
  }
  function closeQr() { qrAborted = true; const m = $("qrModal"); if (m) m.classList.add("hidden"); stopWaitTimer(); }

  // WalletConnect 扫码连币安 App（无 Agentic API 或其后端不可用时的兜底）
  async function connectWC() {
    const W = window.WCMint;
    if (W && W.EthereumProvider) {
      const pid = wcProjectId();
      if (!pid) { showUrlQr(); showMsg("未配置 WalletConnect projectId，已改用网址码在币安 App 内打开。", "err"); return; }
      try {
        showMsg("正在建立连接…");
        let gotUri = false;
        const slow = setTimeout(() => { if (!gotUri) showUrlQr(); }, 15000);
        const clearSlow = () => clearTimeout(slow);
        wcProvider = await W.EthereumProvider.init({
          projectId: pid, chains: [BSC_CHAIN_ID], optionalChains: [BSC_CHAIN_ID], showQrModal: false,
          methods: ["eth_sendTransaction", "eth_requestAccounts", "eth_accounts", "eth_chainId", "wallet_switchEthereumChain"],
          events: ["chainChanged", "accountsChanged"],
        });
        wcProvider.on("display_uri", (arg) => {
          let uri = typeof arg === "string" ? arg : arg && (arg.uri || arg.data || arg.params);
          if (uri && typeof uri !== "string") uri = String(uri.uri || uri.data || uri);
          gotUri = true; clearSlow(); showQr(uri || "");
        });
        const accs = await wcProvider.request({ method: "eth_requestAccounts" });
        clearSlow(); closeQr();
        if ($("awBadge")) { $("awBadge").textContent = "已连接"; $("awBadge").classList.add("ok"); }
        await applyConnected(wcProvider, accs[0]);
      } catch (e) {
        clearSlow(); closeQr();
        showMsg("WalletConnect 连接失败：" + ((e && e.shortMessage) || e.message || e), "err");
      }
      return;
    }
    showMsg("当前环境无法加载扫码组件，请改用浏览器钱包或在币安 App 内打开。", "err");
  }

  function onAccountChanged(addr) {
    currentAccount = addr;
    if (tokenContract && addr) refreshAccount();
    else if (!addr) {
      $("topWallet").textContent = "未连接";
      $("connectBtn").textContent = "连接币安 AI 钱包";
    }
  }

  /* ---------- 加载合约信息（V3 引擎） ---------- */
  async function loadInfo() {
    const silent = arguments[0] === true;
    contractAddr = ($("contract").value || "").trim();
    if (!ethers.isAddress(contractAddr)) return showMsg("请输入有效的合约地址", "err");
    $("bscLink").href = EXPLORER + "/address/" + contractAddr;
    try {
      tokenContract = new ethers.Contract(contractAddr, V3_ABI, readProv());
      const c = tokenContract;
      const [price, cap, minted, myShares, nftAddr, ts, per] = await Promise.all([
        c.mintPrice(), c.totalSharesCap(), c.totalSharesMinted(),
        c.mintedShares(currentAccount || ZERO), c.agentIdNft(),
        c.totalSupply(), c.mintTokensPerShare()
      ]);
      meta.price = price;
      meta.requiredNFT = nftAddr;
      const priceBnb = Number(ethers.formatUnits(price, 18));
      curPriceBnb = priceBnb;
      const mintedN = Number(minted), capN = Number(cap);
      const raised = priceBnb * mintedN;
      const pct = capN > 0 ? Math.min(100, (mintedN / capN) * 100) : 0;
      const opened = mintedN >= capN;

      $("heroName").textContent = meta.name;
      $("heroSymbol").textContent = meta.symbol;
      $("topName").textContent = meta.name;
      document.title = meta.name + " · " + meta.symbol + " 铸造";

      $("infoName").textContent = meta.name;
      $("infoSymbol").textContent = meta.symbol;
      $("infoPrice").textContent = priceBnb + " BNB / 份";
      $("infoProgress").textContent = mintedN + " / " + capN + " 份";

      $("progBar").style.width = pct.toFixed(1) + "%";
      $("progPct").textContent = pct.toFixed(1) + "%";
      $("progOf").textContent = mintedN + " / " + capN + " 份";
      $("progRaised").textContent = raised.toFixed(2) + " BNB";
      $("progLeft").textContent = (capN - mintedN) + " 份";
      $("progPrice").textContent = priceBnb + " BNB";
      $("progState").textContent = opened ? "已开盘" : "未开盘（铸造中）";
      $("progStatus").textContent = opened ? "已结束" : "铸造进行中";
      $("infoStatus").textContent = opened ? "已开盘" : "未开盘（铸造中）";

      if ($("mPrice")) $("mPrice").textContent = priceBnb + " BNB";
      if ($("mTarget")) $("mTarget").textContent = capN + " 份";
      if ($("mRaised")) $("mRaised").textContent = raised.toFixed(2) + " BNB";

      // 发行机制概览（V3：买卖税各 2%，100% 销毁；无单地址上限）
      $("feeCard").classList.remove("hidden");
      const setFee = (id, v) => { const e = $(id); if (e) e.textContent = v; };
      setFee("feeBuyHold", "0%"); setFee("feeBuyLP", "0%"); setFee("feeBuyMarketing", "0%");
      setFee("feeBuyBurn", "2%"); setFee("feeBuyTotal", "2%");
      setFee("feeSellHold", "0%"); setFee("feeSellLP", "0%"); setFee("feeSellMarketing", "0%");
      setFee("feeSellBurn", "2%"); setFee("feeSellTotal", "2%");
      if ($("mCap")) $("mCap").textContent = "不限";

      $("tokenInfo").classList.remove("hidden");
      $("addTokenBtn").classList.remove("hidden");
      $("mintBtn").disabled = opened || !currentAccount;
      if (opened) { if (!silent) showMsg("该代币已开盘，铸造已结束。", "err"); }
      else if (!silent) showMsg("已加载 " + meta.name + " (" + meta.symbol + ")", "ok");

      updateTotals();
      updateAiPrompt();

      if (currentAccount) await refreshAccount();
    } catch (e) {
      if (!silent) showMsg("加载失败：" + (e.reason || e.message || e), "err");
    }
  }

  /* ---------- 当前账户信息（V3） ---------- */
  async function refreshAccount() {
    if (!tokenContract || !currentAccount) return;
    const c = tokenContract;
    try {
      const [bal, mintedCount] = await Promise.all([
        c.balanceOf(currentAccount),
        c.mintedShares(currentAccount),
      ]);
      $("infoBal").textContent = ethers.formatUnits(bal, meta.decimals);
      $("infoMinted").textContent = mintedCount.toString() + " 份（不限上限）";
      $("infoMyLeft").textContent = "不限";

      const nAddr = meta.requiredNFT;
      if (nAddr && nAddr !== ZERO) {
        try {
          const nft = new ethers.Contract(nAddr, NFT_ABI, readProv());
          const nbal = await nft.balanceOf(currentAccount);
          const ok = nbal > 0n;
          $("infoNFT").textContent = ok ? "已持有 ✅（满足门槛）" : "未持有 ❌（无法铸造）";
          if ($("mintBtn")) $("mintBtn").disabled = !ok;
        } catch { $("infoNFT").textContent = nAddr; }
      } else {
        $("infoNFT").textContent = "无门槛";
      }
    } catch (_) { /* 忽略 */ }
  }

  /* ---------- 铸造（V3） ---------- */
  async function mint() {
    if (!tokenContract) return showMsg("请先加载合约信息", "err");
    if (!currentAccount) return showMsg("请先连接钱包", "err");
    if (!signer) return showMsg("钱包未就绪，请重新连接后再铸造", "err");
    if (meta.price == 0n) return showMsg("合约价格尚未加载", "err");

    let n = parseInt($("mintQty").value || "1", 10);
    if (!Number.isFinite(n) || n < 1) n = 1;

    try {
      const price = meta.price;
      const cost = price * BigInt(n);
      const referrer = ZERO;
      const c = tokenContract.connect(signer);
      showMsg("准备铸造 " + n + " 份，共 " + ethers.formatUnits(cost, 18) + " BNB，请在钱包确认…", "");
      const tx = await c.mint(BigInt(n), referrer, cost, { value: cost });
      showMsg("交易已提交：" + tx.hash, "ok");
      await tx.wait();
      showMsg("✅ 铸造成功（" + n + " 份），可在 BscScan 查看", "ok");
      await loadInfo(true);
    } catch (e) {
      showMsg("铸造失败：" + (e.reason || e.message || e), "err");
    }
  }

  /* ---------- 份数 → 预计支付 / AI 指令 同步 ---------- */
  function updateTotals() {
    const n = parseInt($("mintQty").value || "1", 10) || 1;
    const unit = curPriceBnb;
    if ($("mintUnit")) $("mintUnit").innerHTML = (isNaN(unit) ? "—" : unit.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")) + " BNB / 份<br /><span style=\"color:#6b7f72\">不含 gas</span>";
    if ($("mintTotal")) $("mintTotal").textContent = isNaN(unit) ? "—" : (unit * n).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    if ($("ruleQty")) $("ruleQty").textContent = n + " 份";
    if ($("ruleCost")) $("ruleCost").textContent = isNaN(unit) ? "—" : (unit * n).toFixed(6) + " BNB";
    if ($("ruleLeft")) $("ruleLeft").textContent = "不限";
    updateAiPrompt();
  }

  function updateAiPrompt() {
    const a = contractAddr;
    const n = parseInt($("mintQty").value || "1", 10) || 1;
    const wei = meta.price ? meta.price * BigInt(n) : 0n;
    const costBnb = meta.price ? Number(ethers.formatUnits(wei, 18)).toFixed(6) : "?";
    const pre = $("aiPrompt");
    if (!pre) return;
    pre.textContent =
`请使用当前已连接的币安 Agent 钱包，在 BNB Smart Chain（链 ID 56）上调用铸造合约完成铸造：

- 合约地址：${a}
- 调用函数：mint(uint256 shares, address referrer, uint256 maxCost)
- shares = ${n}（铸造份数）
- referrer = ${ZERO}（无推荐人）
- maxCost = ${wei.toString()}（wei，等于应付 BNB 上限，约 ${costBnb} BNB）
- 交易需附带 BNB value = ${wei.toString()}（约 ${costBnb} BNB）
- 前置条件：你的钱包需持有币安 Agent ID NFT（否则会 revert）

请预览交易详情并签名确认，无需连接第三方网站、无需提供私钥。`;
  }

  /* ---------- 添加到钱包 ---------- */
  async function addToken() {
    const eth = window.ethereum || window.BinanceChain;
    if (!eth || !meta.symbol) return;
    try {
      await eth.request({
        method: "wallet_watchAsset",
        params: {
          type: "ERC20",
          options: {
            address: contractAddr,
            symbol: meta.symbol,
            decimals: meta.decimals,
            image: "",
          },
        },
      });
    } catch (e) {
      showMsg("添加失败：" + (e.message || e), "err");
    }
  }

  /* ---------- 份数步进 ---------- */
  function setQty(v) {
    v = Math.max(1, Math.min(10, v | 0));
    $("mintQty").value = v;
    updateTotals();
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $("connectBtn").addEventListener("click", connect);
    const _qrCancel = $("qrCancel");
    if (_qrCancel) _qrCancel.addEventListener("click", () => { clearAgenticLogin(); closeQr(); });
    $("loadBtn").addEventListener("click", loadInfo);
    $("mintBtn").addEventListener("click", mint);
    $("addTokenBtn").addEventListener("click", addToken);
    $("qtyMinus").addEventListener("click", () => setQty(parseInt($("mintQty").value || "1", 10) - 1));
    $("qtyPlus").addEventListener("click", () => setQty(parseInt($("mintQty").value || "1", 10) + 1));
    $("mintQty").addEventListener("change", (e) => setQty(parseInt(e.target.value || "1", 10)));

    const eth = window.ethereum || window.BinanceChain;
    if (eth && eth.on) {
      eth.on("accountsChanged", (accs) => {
        currentAccount = accs && accs[0] ? accs[0] : null;
        if (currentAccount) {
          onAccountChanged(currentAccount);
        } else {
          signer = null;
          $("connectBtn").textContent = "连接币安 AI 钱包";
          $("topWallet").textContent = "未连接";
        }
        if (tokenContract) loadInfo();
      });
      eth.on("chainChanged", () => location.reload());
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initFrogBg();
    bind();
    // 默认合约地址已填在输入框，打开页面自动加载一次信息
    if (ethers.isAddress($("contract").value.trim())) loadInfo();
    // 每 12 秒自动刷新链上数据（单价 / 进度 / 总量等），无需手动操作
    setInterval(() => loadInfo(true), 12000);
    // 手机从币安 App 返回后自动恢复登录态
    restoreAgenticSession().catch(() => {});
  });
})();
