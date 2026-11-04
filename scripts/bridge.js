// sapgui-java-mcp bridge – runs INSIDE SAP GUI for Java (Nashorn, ES5.1)
//
// Start: log on, then run this file from the Scripting menu (once per GUI start;
// running it again restarts the bridge). It starts a JDK HttpServer on
// 127.0.0.1:<random port> and writes ~/.sapgui-java-mcp/bridge.json
// ({port, token, ...}, mode 600). Every request needs
//   Authorization: Bearer <token>
// Requests are processed one at a time (single-thread executor).
//
// Endpoints (POST JSON body, GET allowed for status/screen):
//   /status                               bridge + connections + sessions
//   /screen   {session?, includeMenus?, maxNodes?}
//   /set      {session?, id, value, by?:"key"|"value"}   text/checkbox/radio/combo
//   /press    {session?, id}              button / tab / menu / radio
//   /vkey     {session?, vkey, window?}   0=Enter 3=F3 8=F8 11=Ctrl+S 12=Esc …
//   /tcode    {session?, tcode}           startTransaction
//   /command  {session?, command}         sendCommand (OK-code, e.g. "/nSE16N")
//   /grid     {session?, id, firstRow?, maxRows?, columns?}   ALV grid rows
//   /tree     {session?, id, maxNodes?}   tree nodes (key, parent, text, folder, expanded)
//   /table    {session?, id, firstRow?, maxRows?, columns?, skipEmpty?}   dynpro table control rows
//             (scrolls the table for rows outside the visible page)
//   /stop                                 stop the bridge
// Action endpoints return the resulting screen summary unless {"returnScreen": false}.
//
// Optional config ~/.sapgui-java-mcp/config.json:
//   {"allowedSystems": ["DEV/100"], "readOnly": false}
// No generic eval endpoint – by design.

(function () {
  var BRIDGE_VERSION = "0.1.0";

  var System = Java.type("java.lang.System");
  var Files = Java.type("java.nio.file.Files");
  var Paths = Java.type("java.nio.file.Paths");
  var JString = Java.type("java.lang.String");
  var HttpServer = Java.type("com.sun.net.httpserver.HttpServer");
  var HttpHandler = Java.type("com.sun.net.httpserver.HttpHandler");
  var InetSocketAddress = Java.type("java.net.InetSocketAddress");
  var InetAddress = Java.type("java.net.InetAddress");
  var Executors = Java.type("java.util.concurrent.Executors");
  var SecureRandom = Java.type("java.security.SecureRandom");
  var PosixFilePermissions = Java.type("java.nio.file.attribute.PosixFilePermissions");
  var StandardOpenOption = Java.type("java.nio.file.StandardOpenOption");

  var KEY = "sapgui-java-mcp.bridge";
  var home = System.getProperty("user.home");
  var dir = Paths.get(home, ".sapgui-java-mcp");
  var infoFile = dir.resolve("bridge.json");
  var logFile = dir.resolve("bridge.log");
  var cfgFile = dir.resolve("config.json");

  // ---------------------------------------------------------------- helpers
  function readText(p) { return String(new JString(Files.readAllBytes(p), "UTF-8")); }
  function writeText(p, s, append) {
    var b = new JString(s).getBytes("UTF-8");
    if (append) Files.write(p, b, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    else Files.write(p, b);
  }
  function chmod600(p) {
    try { Files.setPosixFilePermissions(p, PosixFilePermissions.fromString("rw-------")); } catch (e) { }
  }
  function str(x) { return (x === null || x === undefined) ? "" : String(x); }
  function errText(e) {
    if (e && e.getMessage) { var m = e.getMessage(); return str(e.getClass().getSimpleName()) + (m ? ": " + m : ""); }
    return str(e);
  }
  function BridgeError(status, message) { this.status = status; this.message = message; }
  function fail(status, message) { throw new BridgeError(status, message); }

  function loadConfig() {
    var cfg = { allowedSystems: ["DEV/100"], readOnly: false };
    try {
      if (Files.exists(cfgFile)) {
        var c = JSON.parse(readText(cfgFile));
        for (var k in c) cfg[k] = c[k];
      }
    } catch (e) { audit({ event: "config-error", error: errText(e) }); }
    return cfg;
  }

  function audit(rec) {
    try {
      rec.ts = new Date().toISOString();
      writeText(logFile, JSON.stringify(rec) + "\n", true);
      chmod600(logFile);
    } catch (e) { }
  }

  // iterate GuiCollection / java.util.List / Java array / JS array / "a,b" string
  function toList(x) {
    var r = [], i;
    if (x === null || x === undefined) return r;
    if (typeof x === "string") return x === "" ? r : x.split(",");
    if (Array.isArray(x)) return x;
    try { if (typeof x.getLength === "function") { var n = x.getLength(); for (i = 0; i < n; i++) r.push(x.elementAt(i)); return r; } } catch (e) { }
    try { if (typeof x.size === "function") { var s = x.size(); for (i = 0; i < s; i++) r.push(x.get(i)); return r; } } catch (e) { }
    try { if (Java.isJavaObject(x) && x.getClass().isArray()) { var a = Java.from(x); return a; } } catch (e) { }
    if (typeof x.length === "number") { for (i = 0; i < x.length; i++) r.push(x[i]); return r; }
    return [x];
  }

  function tryCall(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }

  // ---------------------------------------------------------- SAP GUI access
  var presetApp = (typeof application !== "undefined") ? application : null;
  // remember the GUI class loader while the preset object is valid
  var sapLoader = presetApp !== null ? presetApp.getClass().getClassLoader() : null;

  function getApp() {
    if (presetApp !== null) {
      try { presetApp.getConnections(); return presetApp; } catch (e) { presetApp = null; }
    }
    // the script scope may have been cleaned up – build a fresh wrapper like the interpreter does
    // (GuiApplicationWrapper(GuiApplication.currentApplication(), null)), via reflection on the GUI loader
    if (sapLoader === null) fail(503, "bridge was not started from SAP GUI (no 'application' object)");
    try {
      var OBJ = Java.type("java.lang.Object").class;
      var appCls = sapLoader.loadClass("com.sap.platin.base.application.GuiApplication");
      var wrapCls = sapLoader.loadClass("com.sap.platin.base.api.scripting.GuiApplicationWrapper");
      var guiApp = appCls.getMethod("currentApplication").invoke(null);
      var ctor = wrapCls.getConstructor(OBJ, OBJ);
      presetApp = ctor.newInstance(Java.to([guiApp, null], "java.lang.Object[]"));
    } catch (e) {
      fail(503, "cannot obtain SAP GUI application object: " + errText(e));
    }
    return presetApp;
  }

  function sessionPath(body) {
    var s = str(body.session);
    if (s === "") return "/app/con[0]/ses[0]";
    if (s.indexOf("/app/") === 0) return s;
    return "/app/" + s.replace(/^\/+/, "");
  }

  function getSession(body) {
    var app = getApp();
    var p = sessionPath(body);
    var ses = tryCall(function () { return app.findById(p); }, null);
    if (ses === null) fail(404, "session not found: " + p + " (use /status to list sessions)");
    if (typeof ses === "string") fail(403, ses);
    return ses;
  }

  function sessionInfo(ses) {
    var i = ses.getInfo();
    return {
      id: str(ses.getId()),
      system: str(i.getSystemName()), client: str(i.getClient()), user: str(i.getUser()),
      language: str(i.getLanguage()), transaction: str(i.getTransaction()),
      program: str(i.getProgram()), screen: Number(i.getScreenNumber()),
      appServer: str(i.getApplicationServer()), readOnly: !!i.isScriptingModeReadOnly()
    };
  }

  function checkAllowed(ses, cfg, isWrite) {
    var inf = sessionInfo(ses);
    var key = inf.system + "/" + inf.client;
    var allowed = toList(cfg.allowedSystems);
    if (allowed.length > 0 && allowed.indexOf(key) < 0 && allowed.indexOf("*") < 0)
      fail(403, "system " + key + " not in allowedSystems " + JSON.stringify(allowed));
    if (isWrite && cfg.readOnly) fail(403, "bridge is in readOnly mode");
    if (isWrite && inf.readOnly) fail(403, "SAP scripting is read-only for this session");
    return inf;
  }

  function relId(id) { return str(id).replace(/^\/app\/con\[\d+\]\/ses\[\d+\]\//, ""); }

  function findEl(ses, id) {
    id = str(id);
    if (id === "") fail(400, "missing 'id'");
    var el = tryCall(function () { return ses.findById(id.replace(/^\/app\/con\[\d+\]\/ses\[\d+\]\//, "")); }, null);
    if (el === null) fail(404, "element not found: " + id);
    return el;
  }

  function statusBar(ses, wndId) {
    var sb = tryCall(function () { return ses.findById((wndId || "wnd[0]") + "/sbar"); }, null);
    if (sb === null && wndId) sb = tryCall(function () { return ses.findById("wnd[0]/sbar"); }, null);
    if (sb === null) return null;
    return {
      type: str(tryCall(function () { return sb.getMessageType(); }, "")),
      text: str(tryCall(function () { return sb.getText(); }, "")),
      id: str(tryCall(function () { return sb.getMessageId(); }, "")),
      number: str(tryCall(function () { return sb.getMessageNumber(); }, ""))
    };
  }

  var INPUT_TYPES = { GuiTextField: 1, GuiCTextField: 1, GuiPasswordField: 1, GuiOKCodeField: 1, GuiComboBox: 1, GuiCheckBox: 1, GuiRadioButton: 1 };
  var SKIP_SUBTREE = { GuiMenuBar: 1 };

  function describeNode(n) {
    var type = str(tryCall(function () { return n.getType(); }, "?"));
    var d = { id: relId(n.getId()), type: type };
    var t = tryCall(function () { return n.getText(); }, null);
    if (t !== null && str(t) !== "") d.text = str(t);
    var tip = tryCall(function () { return n.getTooltip(); }, null);
    if (tip !== null && str(tip) !== "" && str(tip) !== d.text) d.tooltip = str(tip);
    if (INPUT_TYPES[type]) {
      d.changeable = !!tryCall(function () { return n.isChangeable(); }, false);
      if (type === "GuiCheckBox" || type === "GuiRadioButton") d.selected = !!tryCall(function () { return n.isSelected(); }, false);
      if (type === "GuiComboBox") d.key = str(tryCall(function () { return n.getKey(); }, ""));
      if (tryCall(function () { return n.isRequired(); }, false)) d.required = true;
    }
    if (type === "GuiShell") {
      d.control = str(n.getClass().getSimpleName());
      var st = tryCall(function () { return n.getSubtype(); }, null);
      if (st !== null) d.subtype = str(st);
      if (d.control === "SapGridWrapper") {
        d.rowCount = tryCall(function () { return Number(n.getRowCount()); }, undefined);
        d.title = tryCall(function () { return str(n.getTitle()); }, undefined);
      }
    }
    if (type === "GuiTableControl") d.rowCount = tryCall(function () { return Number(n.getRowCount()); }, undefined);
    return d;
  }

  function walkWindow(win, opts, outArr) {
    var count = { n: 0 };
    function walk(node, depth) {
      if (count.n >= opts.maxNodes) return;
      var d = describeNode(node);
      // skip pure layout containers without text to keep output small
      var isLayout = /^(GuiUserArea|GuiSimpleContainer|GuiScrollContainer|GuiContainerShell|GuiSplitterShell|GuiCustomControl|GuiDockShell|GuiTitleBar)$/.test(d.type);
      if (!isLayout || d.text) { outArr.push(d); count.n++; }
      if (!opts.includeMenus && SKIP_SUBTREE[d.type]) return;
      if (d.type === "GuiShell" || d.type === "GuiTableControl") return; // read via /grid /tree
      var kids = tryCall(function () { return node.getChildren(); }, null);
      if (kids === null) return;
      var list = toList(kids);
      for (var i = 0; i < list.length; i++) walk(list[i], depth + 1);
    }
    walk(win, 0);
    return count.n >= opts.maxNodes;
  }

  function screen(ses, body) {
    var opts = { includeMenus: !!body.includeMenus, maxNodes: body.maxNodes ? Number(body.maxNodes) : 400 };
    var res = { session: sessionInfo(ses), windows: [], elements: [] };
    var active = tryCall(function () { return relId(ses.getActiveWindow().getId()); }, "wnd[0]");
    res.activeWindow = active;
    for (var w = 0; w < 10; w++) {
      var win = tryCall(function () { return ses.findById("wnd[" + w + "]"); }, null);
      if (win === null) continue;
      res.windows.push({ id: "wnd[" + w + "]", type: str(win.getType()), title: str(tryCall(function () { return win.getText(); }, "")) });
    }
    var activeWin = ses.findById(active);
    res.truncated = walkWindow(activeWin, opts, res.elements);
    res.statusBar = statusBar(ses, active);
    return res;
  }

  // ----------------------------------------------------------- operations
  function opStatus() {
    var app = getApp();
    var res = {
      bridge: BRIDGE_VERSION,
      gui: app.getMajorVersion() + "." + app.getMinorVersion() + " rev " + app.getRevision() + " pl " + app.getPatchLevel(),
      connections: []
    };
    var cons = toList(app.getConnections());
    for (var c = 0; c < cons.length; c++) {
      var con = cons[c];
      var cd = {
        id: relId(con.getId()) || str(con.getId()),
        description: str(tryCall(function () { return con.getDescription(); }, "")),
        connectionString: str(tryCall(function () { return con.getConnectionString(); }, "")),
        disabledByServer: !!tryCall(function () { return con.isDisabledByServer(); }, true),
        sessions: []
      };
      if (!cd.disabledByServer) {
        var sess = toList(tryCall(function () { return con.getSessions(); }, null));
        for (var s = 0; s < sess.length; s++) {
          if (typeof sess[s] === "string") { cd.sessions.push({ error: sess[s] }); continue; }
          cd.sessions.push(tryCall(function () { return sessionInfo(sess[s]); }, { error: "session not readable" }));
        }
      }
      res.connections.push(cd);
    }
    return res;
  }

  function after(ses, body, res) {
    if (body.returnScreen === false) return res;
    res.screen = screen(ses, { maxNodes: body.maxNodes || 400, includeMenus: false });
    return res;
  }

  function opSet(ses, body) {
    var el = findEl(ses, body.id);
    var type = str(el.getType());
    var v = body.value;
    switch (type) {
      case "GuiCheckBox": el.setSelected(v === true || v === "true" || v === "X"); break;
      case "GuiRadioButton": el.select(); break;
      case "GuiComboBox": if (body.by === "value") el.setValue(str(v)); else el.setKey(str(v)); break;
      case "GuiTextField": case "GuiCTextField": case "GuiPasswordField": case "GuiOKCodeField":
        el.setText(str(v)); break;
      default: fail(400, "cannot set value on " + type + " (" + relId(el.getId()) + ")");
    }
    var back = type === "GuiPasswordField" ? "***" :
      tryCall(function () { return type === "GuiCheckBox" || type === "GuiRadioButton" ? el.isSelected() : str(el.getText()); }, null);
    return { ok: true, id: relId(el.getId()), type: type, value: back };
  }

  function opPress(ses, body) {
    var el = findEl(ses, body.id);
    var type = str(el.getType());
    switch (type) {
      case "GuiButton": el.press(); break;
      case "GuiTab": case "GuiMenu": case "GuiRadioButton": el.select(); break;
      default: fail(400, "cannot press " + type + " (" + relId(el.getId()) + ") – use /grid or /tree for controls");
    }
    return after(ses, body, { ok: true, id: str(body.id), type: type });
  }

  function opVKey(ses, body) {
    if (body.vkey === undefined) fail(400, "missing 'vkey'");
    var wid = body.window ? str(body.window) : tryCall(function () { return relId(ses.getActiveWindow().getId()); }, "wnd[0]");
    var win = findEl(ses, wid);
    win.sendVKey(Number(body.vkey) | 0);
    return after(ses, body, { ok: true, window: wid, vkey: Number(body.vkey) });
  }

  function opTcode(ses, body) {
    var t = str(body.tcode).replace(/^\/[nNoO]/, "");
    if (t === "") fail(400, "missing 'tcode'");
    ses.startTransaction(t);
    return after(ses, body, { ok: true, tcode: t });
  }

  function opCommand(ses, body) {
    if (str(body.command) === "") fail(400, "missing 'command'");
    ses.sendCommand(str(body.command));
    return after(ses, body, { ok: true, command: str(body.command) });
  }

  function opGrid(ses, body) {
    var g = findEl(ses, body.id);
    if (str(g.getClass().getSimpleName()) !== "SapGridWrapper") fail(400, "not an ALV grid: " + relId(g.getId()) + " (" + g.getClass().getSimpleName() + ")");
    var rowCount = Number(g.getRowCount());
    var first = body.firstRow ? Number(body.firstRow) : 0;
    var max = body.maxRows ? Math.min(Number(body.maxRows), 500) : 50;
    var cols = body.columns ? toList(body.columns) : toList(g.getColumnOrder());
    var colInfo = [];
    for (var c = 0; c < cols.length; c++) {
      var name = str(cols[c]);
      colInfo.push({ name: name, title: str(tryCall(function () { return g.getDisplayedColumnTitle(name); }, "")) });
    }
    var rows = [];
    var visible = Math.max(1, Number(tryCall(function () { return g.getVisibleRowCount(); }, 20)));
    var last = Math.min(rowCount, first + max);
    for (var r = first; r < last; r++) {
      // rows are loaded lazily – scroll the window when leaving the visible range
      var fv = Number(tryCall(function () { return g.getFirstVisibleRow(); }, 0));
      if (r < fv || r >= fv + visible) tryCall(function () { g.setFirstVisibleRow(r); return 0; }, 0);
      var row = {};
      for (var k = 0; k < colInfo.length; k++) {
        var cn = colInfo[k].name;
        row[cn] = str(tryCall(function () { return g.getCellValue(r, cn); }, ""));
      }
      rows.push(row);
    }
    return {
      id: relId(g.getId()), title: str(tryCall(function () { return g.getTitle(); }, "")),
      rowCount: rowCount, firstRow: first, returned: rows.length, columns: colInfo, rows: rows
    };
  }

  // underlying GUI control object of a scripting wrapper (field mScriptObject), or null
  function scriptObject(w) {
    return tryCall(function () {
      var cls = w.getClass();
      while (cls !== null) {
        try {
          var f = cls.getDeclaredField("mScriptObject");
          f.setAccessible(true);
          return f.get(w);
        } catch (e) { cls = cls.getSuperclass(); }
      }
      return null;
    }, null);
  }

  // value of one table cell (text field, checkbox, combo, button, label …)
  function cellValue(cell) {
    var type = str(tryCall(function () { return cell.getType(); }, ""));
    if (type === "GuiCheckBox" || type === "GuiRadioButton")
      return tryCall(function () { return cell.isSelected(); }, false) ? "X" : "";
    if (type === "GuiComboBox") return str(tryCall(function () { return cell.getKey(); }, ""));
    if (type === "GuiPasswordField") return "***";
    return str(tryCall(function () { return cell.getText(); }, ""));
  }

  // Dynpro table control. Cells are addressed by VISIBLE row: <table>/<field>[col,visibleRow].
  // Rows outside the visible page are not on the client, so reading further pages scrolls the
  // table (vertical scrollbar → server round trip). Cell ids returned refer to the final scroll position.
  function opTable(ses, body) {
    var id = relId(findEl(ses, body.id).getId());
    var t = findEl(ses, id);
    if (str(t.getType()) !== "GuiTableControl") fail(400, "not a table control: " + id + " (" + t.getType() + ") – use /grid for ALV grids");
    var rowCount = Number(t.getRowCount());
    var sb0 = tryCall(function () { return t.getVerticalScrollbar(); }, null);
    var startPos = sb0 ? Number(tryCall(function () { return sb0.getPosition(); }, 0)) : 0;
    var first = (body.firstRow === undefined || body.firstRow === null) ? startPos : Number(body.firstRow);
    var max = body.maxRows ? Math.min(Number(body.maxRows), 500) : 50;
    var skipEmpty = body.skipEmpty !== false;
    // The vertical scrollbar's maximum is the number of DATA lines (verified: SE16H T001 → 82 = DD03L
    // fields; single-line ZDISPLAY lists → 1). rowCount also counts the empty lines below the data.
    var dataRows = sb0 ? Number(tryCall(function () { return sb0.getMaximum(); }, rowCount)) : rowCount;
    if (!(dataRows >= 0) || dataRows > rowCount) dataRows = rowCount;
    var limit = skipEmpty ? dataRows : rowCount;
    var last = Math.min(limit, first + max);

    // Column metadata. getColumns() is NOT in getCell() order when a line layout reorders the
    // columns (seen in ZDISPLAY), so titles are matched by field name: each GuiTableColumn is a
    // collection of its cells, elementAt(0).getName() is the field.
    var colsW = toList(t.getColumns());
    var titleByName = {}, titleByPos = [];
    for (var c = 0; c < colsW.length; c++) {
      var cw = colsW[c];
      var ttl = str(tryCall(function () { return cw.getTitle(); }, ""));
      titleByPos.push(ttl);
      var fn = str(tryCall(function () { return cw.elementAt(0).getName(); }, ""));
      if (fn !== "") titleByName[fn] = ttl;
    }
    // a column may have no cell in some rows (e.g. SE16H row MANDT) – use the first row that has one
    var probeRows = Math.max(1, Math.min(60, Number(tryCall(function () { return t.getVisibleRowCount(); }, 1))));
    function firstCell(ci) {
      for (var pr = 0; pr < probeRows; pr++) {
        var x = tryCall(function () { return t.getCell(pr, ci); }, null);
        if (x !== null && x !== undefined) return x;
      }
      return null;
    }
    // GuiTableColumnWrapper.getTitle() maps the column index twice (p2mColumn inside
    // getPersonasColumnTitle) → wrong titles when a line layout reorders columns (ZDISPLAY Z03).
    // Read the titles from the underlying GuiTableControl instead (reflection on mScriptObject).
    var ctl = scriptObject(t);
    var ctlErr = null;
    function ctlCall(name, arg) {
      try { return ctl[name](arg | 0); }
      catch (e) { if (ctlErr === null) ctlErr = name + ": " + errText(e); return null; }
    }
    var cols = [];
    for (c = 0; c < colsW.length; c++) {
      var cell0 = firstCell(c);
      var cid = cell0 !== null ? relId(str(cell0.getId())) : "";
      var nm = cell0 !== null ? str(tryCall(function () { return cell0.getName(); }, "")) : "";
      var m = /\[(\d+),\d+\]$/.exec(cid);
      cols.push({
        index: c,
        idCol: m ? Number(m[1]) : c,
        name: nm,
        title: titleByName.hasOwnProperty(nm) ? titleByName[nm] : (titleByPos[c] || ""),
        type: cell0 !== null ? str(tryCall(function () { return cell0.getType(); }, "")).replace(/^Gui/, "") : "",
        idPrefix: cid.replace(/\[\d+,\d+\]$/, "")
      });
      if (ctl !== null) {
        var p2m = ctlCall("p2mColumn", c), m2p = ctlCall("m2pColumn", c);
        cols[c].titles = {
          wrapper: titleByPos[c] || "",
          direct: str(ctlCall("getColumnName", c)),
          p2m: p2m === null ? "" : str(ctlCall("getColumnName", Number(p2m))),
          m2p: m2p === null ? "" : str(ctlCall("getColumnName", Number(m2p))),
          wrapperM2p: m2p === null ? "" : (titleByPos[Number(m2p)] || ""),
          personas: str(ctlCall("getPersonasColumnName", c))
        };
        if (body.debugTitles) cols[c].titleDebug = { p2m: p2m, m2p: m2p, ctlClass: str(ctl.getClass().getName()), err: ctlErr };
      }
    }
    // pick the title source; all variants except "wrapper" come from the control itself
    // default "p2m" = getColumnName(p2mColumn(c)), verified against the screen in ZDISPLAY (line layout Z03);
    // "wrapper" (GuiTableColumnWrapper.getTitle) maps the index twice and is wrong for reordered columns
    var mode = str(body.titleMode || "p2m");
    for (c = 0; c < cols.length; c++)
      if (cols[c].titles && mode !== "wrapper" && cols[c].titles[mode] !== undefined && cols[c].titles[mode] !== "")
        cols[c].title = cols[c].titles[mode];
    if (!body.debugTitles) for (c = 0; c < cols.length; c++) delete cols[c].titles;
    var wanted = null;
    if (body.columns) {
      wanted = {};
      var wl = toList(body.columns);
      for (var w = 0; w < wl.length; w++) wanted[str(wl[w]).toUpperCase()] = 1;
    }
    var useCols = [];
    for (c = 0; c < cols.length; c++)
      if (wanted === null || wanted[cols[c].name.toUpperCase()] || wanted[cols[c].title.toUpperCase()]) useCols.push(cols[c]);

    var rows = [], scrolled = false, pos = startPos, emptySkipped = 0;
    var r = first, scrolls = 0, endOfData = false;
    while (r < last) {
      var visible = Math.max(1, Number(tryCall(function () { return t.getVisibleRowCount(); }, 1)));
      if (r < pos || r >= pos + visible) {
        if (++scrolls > 200) break;                   // safety net
        if (sb0 === null) break;                      // table without scrollbar: only the visible page exists
        var sb = t.getVerticalScrollbar();
        var target = Math.min(r, Math.max(0, Number(sb.getMaximum())));
        sb.setPosition(target);                      // server round trip
        t = findEl(ses, id);                          // wrapper is stale after the round trip
        var np = Number(tryCall(function () { return t.getVerticalScrollbar().getPosition(); }, target));
        scrolled = true;
        if (np === pos) { endOfData = true; break; }  // could not scroll further
        pos = np;
        if (r < pos) r = pos;
        continue;
      }
      var vr = r - pos;
      var row = { row: r, visibleRow: vr, cells: {} };
      var any = false, editable = false;
      for (var k = 0; k < useCols.length; k++) {
        var col = useCols[k];
        var cell = tryCall(function () { return t.getCell(vr, col.index); }, null);
        var v = cell !== null ? cellValue(cell) : "";
        if (v !== "") any = true;
        if (cell !== null && tryCall(function () { return cell.isChangeable(); }, false)) editable = true;
        row.cells[col.name || ("#" + col.index)] = v;
      }
      if (editable) row.editable = true;
      if (tryCall(function () { return t.getAbsoluteRow(r).isSelected(); }, false)) row.selected = true;
      if (any || !skipEmpty) rows.push(row); else emptySkipped++;
      r++;
    }
    if (r >= limit) endOfData = true;
    var visibleNow = Number(tryCall(function () { return t.getVisibleRowCount(); }, 0));
    var sbE = tryCall(function () { return t.getVerticalScrollbar(); }, null);
    var scrollbar = sbE === null ? null : {
      position: Number(tryCall(function () { return sbE.getPosition(); }, -1)),
      maximum: Number(tryCall(function () { return sbE.getMaximum(); }, -1)),
      pageSize: Number(tryCall(function () { return sbE.getPageSize(); }, -1))
    };
    return {
      id: id, title: str(tryCall(function () { return t.getText(); }, "")).trim(),
      rowCount: rowCount, dataRows: dataRows, visibleRowCount: visibleNow, scrollPosition: pos, scrolled: pos !== startPos,
      endOfData: endOfData, scrollbar: scrollbar,
      firstRow: first, lastRow: r - 1, emptySkipped: emptySkipped,
      columns: useCols, rows: rows
    };
  }

  function opTree(ses, body) {
    var t = findEl(ses, body.id);
    if (str(t.getClass().getSimpleName()) !== "SapTreeWrapper") fail(400, "not a tree: " + relId(t.getId()) + " (" + t.getClass().getSimpleName() + ")");
    var max = body.maxNodes ? Math.min(Number(body.maxNodes), 2000) : 300;
    var keys = toList(t.getNodesCol());
    var nodes = [];
    for (var i = 0; i < keys.length && i < max; i++) {
      var k = str(keys[i]);
      nodes.push({
        key: k,
        parent: str(tryCall(function () { return t.getParent(k); }, "")),
        text: str(tryCall(function () { return t.getNodeTextByKey(k); }, "")),
        folder: !!tryCall(function () { return t.isFolder(k); }, false),
        expanded: !!tryCall(function () { return t.isFolderExpanded(k); }, false)
      });
    }
    return { id: relId(t.getId()), total: keys.length, returned: nodes.length, selected: str(tryCall(function () { return t.getSelectedNode(); }, "")), nodes: nodes };
  }

  // ------------------------------------------------------------ http server
  var prev = System.getProperties().get(KEY);
  if (prev !== null) { try { prev.stop(0); } catch (e) { } System.getProperties().remove(KEY); }

  var rnd = new SecureRandom();
  var tok = "";
  for (var i = 0; i < 32; i++) { var b = rnd.nextInt(256); tok += (b < 16 ? "0" : "") + b.toString(16); }

  var server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
  server.setExecutor(Executors.newSingleThreadExecutor());

  var WRITE_OPS = { "/set": 1, "/press": 1, "/vkey": 1, "/tcode": 1, "/command": 1 };

  function respond(ex, code, obj) {
    var bytes = new JString(JSON.stringify(obj)).getBytes("UTF-8");
    ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    ex.sendResponseHeaders(code, bytes.length);
    var os = ex.getResponseBody();
    os.write(bytes);
    os.close();
  }

  server.createContext("/", new HttpHandler({
    handle: function (ex) {
      var path = str(ex.getRequestURI().getPath());
      var t0 = Date.now();
      var body = {};
      var rec = { path: path };
      try {
        var auth = str(ex.getRequestHeaders().getFirst("Authorization"));
        if (auth !== "Bearer " + tok) { rec.status = 401; respond(ex, 401, { error: "unauthorized" }); return; }
        var raw = String(new JString(ex.getRequestBody().readAllBytes(), "UTF-8"));
        if (raw.trim() !== "") {
          try { body = JSON.parse(raw); } catch (pe) { fail(400, "invalid JSON body: " + str(pe.message || pe)); }
        }
        rec.body = {};
        for (var k in body) rec.body[k] = (/pass/i.test(str(body.id)) && k === "value") ? "***" : body[k];

        var cfg = loadConfig();
        var res;
        if (path === "/status") res = opStatus();
        else if (path === "/stop") {
          res = { ok: true, stopping: true };
          respond(ex, 200, res);
          rec.status = 200;
          System.getProperties().remove(KEY);
          try { Files.deleteIfExists(infoFile); } catch (e) { }
          new (Java.type("java.lang.Thread"))(function () { server.stop(0); }).start();
          return;
        } else {
          var ses = getSession(body);
          rec.system = checkAllowed(ses, cfg, !!WRITE_OPS[path]);
          rec.system = rec.system.system + "/" + rec.system.client;
          switch (path) {
            case "/screen": res = screen(ses, body); break;
            case "/set": res = opSet(ses, body); break;
            case "/press": res = opPress(ses, body); break;
            case "/vkey": res = opVKey(ses, body); break;
            case "/tcode": res = opTcode(ses, body); break;
            case "/command": res = opCommand(ses, body); break;
            case "/grid": res = opGrid(ses, body); break;
            case "/tree": res = opTree(ses, body); break;
            case "/table": res = opTable(ses, body); break;
            default: fail(404, "unknown endpoint " + path);
          }
        }
        rec.status = 200;
        respond(ex, 200, res);
      } catch (e) {
        var code = (e instanceof BridgeError) ? e.status : 500;
        var msg = (e instanceof BridgeError) ? e.message : errText(e);
        rec.status = code; rec.error = msg;
        try { respond(ex, code, { error: msg }); } catch (e2) { }
      } finally {
        rec.ms = Date.now() - t0;
        if (rec.status !== 200 || WRITE_OPS[path] || path === "/stop") audit(rec);
      }
    }
  }));

  server.start();
  System.getProperties().put(KEY, server);

  var port = server.getAddress().getPort();
  Files.createDirectories(dir);
  try { Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwx------")); } catch (e) { }
  writeText(infoFile, JSON.stringify({
    port: port, token: tok, version: BRIDGE_VERSION,
    pid: Number(Java.type("java.lang.ProcessHandle").current().pid()),
    started: new Date().toISOString()
  }, null, 2) + "\n");
  chmod600(infoFile);
  audit({ event: "start", port: port, version: BRIDGE_VERSION });

  var msg = "sapgui-java-mcp bridge " + BRIDGE_VERSION + " listening on 127.0.0.1:" + port + "\n" + infoFile;
  try {
    if (!Java.type("java.awt.GraphicsEnvironment").isHeadless())
      Java.type("javax.swing.JOptionPane").showMessageDialog(null, msg);
    else print(msg);
  } catch (e) { print(msg); }
})();
