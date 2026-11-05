// SAP GUI for Java 8.10 – scripting smoke test v2 (READ-ONLY, changes nothing in SAP)
//
// Run: log on to the system, open any transaction, then start this file via the
// Scripting menu / script window of SAP GUI for Java.
// Output: ~/sapgui-java-smoke-test.txt (+ a short summary dialog).
//
// v2: v1 failed with "ses.getInfo is not a function" – the engine does not link
// Java methods on the wrapper objects directly. Every call now goes through
// call(), which tries direct JS invocation first and falls back to Java
// reflection; the report records which path worked ("[js]" / "[refl]").
//
// Engine is Nashorn (ES5.1): no let/const/arrow functions/template strings.

var out = [];
function log(s) { out.push(String(s)); }
function cut(s, n) { s = (s === null || s === undefined) ? "" : String(s); return s.length > n ? s.substring(0, n) + "…" : s; }

var OBJ = Java.type("java.lang.Object");
var GET_CLASS = OBJ.class.getMethod("getClass");
var path = { js: 0, refl: 0 };

function classOf(o) { return GET_CLASS.invoke(o); }

// call(obj, "getInfo") / call(obj, "findById", "wnd[0]")
function call(o, name) {
  var args = Array.prototype.slice.call(arguments, 2);
  if (o === null || o === undefined) throw "call " + name + " on null";
  var f = null;
  try { f = o[name]; } catch (e) { f = null; }
  if (typeof f === "function") {
    // Java methods in Nashorn have no .apply – invoke by arity
    path.js++;
    switch (args.length) {
      case 0: return o[name]();
      case 1: return o[name](args[0]);
      case 2: return o[name](args[0], args[1]);
      default: return o[name](args[0], args[1], args[2]);
    }
  }
  // reflection fallback: first public method with matching name + arity
  var ms = classOf(o).getMethods();
  for (var i = 0; i < ms.length; i++) {
    var m = ms[i];
    if (String(m.getName()) === name && m.getParameterCount() === args.length) {
      var jargs = Java.to(args, "java.lang.Object[]");
      if (args.length > 0) {
        // coerce JS numbers to the declared primitive types
        var pt = m.getParameterTypes();
        for (var a = 0; a < args.length; a++) {
          var tn = String(pt[a].getName());
          if (tn === "int") jargs[a] = Java.type("java.lang.Integer").valueOf(args[a] | 0);
          else if (tn === "long") jargs[a] = Java.type("java.lang.Long").valueOf(args[a]);
          else if (tn === "boolean") jargs[a] = Java.type("java.lang.Boolean").valueOf(!!args[a]);
        }
      }
      path.refl++;
      return m.invoke(o, jargs);
    }
  }
  throw "no method " + name + "/" + args.length + " on " + classOf(o).getName();
}

function safe(label, fn) {
  try { log(label + ": " + fn()); return true; }
  catch (e) { log(label + ": ERROR " + e); return false; }
}

// describe how an object looks from the script's point of view
function describe(label, o) {
  log("--- describe " + label);
  safe("  typeof", function () { return typeof o; });
  safe("  String()", function () { return cut(String(o), 120); });
  safe("  JS class tag", function () { return Object.prototype.toString.call(o); });
  safe("  Java class (reflection)", function () { return classOf(o).getName(); });
  safe("  class loader", function () { return String(classOf(o).getClassLoader()); });
  safe("  Java.isJavaObject", function () { return (typeof Java.isJavaObject === "function") ? Java.isJavaObject(o) : "n/a"; });
  safe("  direct o.getClass", function () { return typeof o.getClass; });
  safe("  JS-visible keys", function () { var k = []; for (var p in o) k.push(p); return k.length + " " + cut(k.join(","), 200); });
  safe("  public methods (reflection)", function () {
    var ms = classOf(o).getMethods(), n = [];
    for (var i = 0; i < ms.length; i++) if (String(ms[i].getDeclaringClass().getName()) !== "java.lang.Object") n.push(ms[i].getName());
    return n.length + " " + cut(n.join(","), 300);
  });
}

log("=== SAP GUI for Java scripting smoke test v2 " + new Date());

// ---- 1. Engine / Java interop ---------------------------------------------
safe("engine", function () {
  return (typeof Graal !== "undefined") ? "GraalJS" : "Nashorn (no Graal global)";
});
safe("java.version", function () { return Java.type("java.lang.System").getProperty("java.version"); });
safe("script thread", function () {
  var t = Java.type("java.lang.Thread").currentThread();
  return t.getName() + " (EDT=" + Java.type("javax.swing.SwingUtilities").isEventDispatchThread() + ")";
});
safe("SecurityManager", function () { return String(Java.type("java.lang.System").getSecurityManager()); });
safe("globals present", function () {
  return "application=" + (typeof application) + ", connection=" + (typeof connection) + ", session=" + (typeof session);
});

// ---- 2. How do the preset objects look? -----------------------------------
if (typeof application !== "undefined") describe("application", application);
if (typeof session !== "undefined" && session !== null) describe("session", session);

// ---- 3. Application / connection / session --------------------------------
safe("GUI version", function () {
  return call(application, "getMajorVersion") + "." + call(application, "getMinorVersion") +
         " rev " + call(application, "getRevision") + " pl " + call(application, "getPatchLevel");
});
safe("connections", function () { return call(call(application, "getConnections"), "getLength"); });

var ses = null;
if (typeof session !== "undefined" && session !== null) {
  ses = session;
  log("session: preset variable");
} else {
  try {
    var con0 = call(call(application, "getConnections"), "elementAt", 0);
    ses = call(call(con0, "getSessions"), "elementAt", 0);
    log("session: via application.connections[0].sessions[0]");
  } catch (e) { log("session: NONE (" + e + ")"); }
}
if (typeof connection !== "undefined" && connection !== null) {
  safe("connection.isDisabledByServer", function () { return call(connection, "isDisabledByServer"); });
  safe("connection.description", function () { return call(connection, "getDescription"); });
  safe("connection.connectionString", function () { return call(connection, "getConnectionString"); });
}

if (ses !== null) {
  var info = null;
  safe("session.getInfo", function () { info = call(ses, "getInfo"); return classOf(info).getSimpleName(); });
  if (info !== null) {
    safe("system/client/user/lang", function () {
      return call(info, "getSystemName") + " / " + call(info, "getClient") + " / " +
             call(info, "getUser") + " / " + call(info, "getLanguage");
    });
    safe("app server", function () { return call(info, "getApplicationServer"); });
    safe("transaction/program/screen", function () {
      return call(info, "getTransaction") + " / " + call(info, "getProgram") + " / " + call(info, "getScreenNumber");
    });
    safe("scripting read-only", function () { return call(info, "isScriptingModeReadOnly"); });
    safe("recording disabled", function () { return call(info, "isScriptingModeRecordingDisabled"); });
  }

  // ---- 4. findById + status bar -------------------------------------------
  safe("wnd[0] title", function () { return call(call(ses, "findById", "wnd[0]"), "getText"); });
  safe("status bar", function () {
    var sb = call(ses, "findById", "wnd[0]/sbar");
    return "[" + call(sb, "getMessageType") + "] " + call(sb, "getText");
  });
  safe("active window", function () {
    var w = call(ses, "getActiveWindow");
    return call(w, "getId") + " (" + call(w, "getType") + ")";
  });

  // ---- 5. Component tree of wnd[0] (depth-limited) ------------------------
  log("--- component tree wnd[0] (id | type | wrapper class | text)");
  var count = 0, shells = [];
  function walk(node, depth) {
    if (count > 400) return;
    count++;
    var line = "";
    for (var i = 0; i < depth; i++) line += "  ";
    var txt = "";
    try { txt = call(node, "getText"); } catch (e) { /* not a VComponent */ }
    var type = "?";
    try { type = String(call(node, "getType")); } catch (e) { }
    line += call(node, "getId") + " | " + type + " | " + classOf(node).getSimpleName() + " | " + cut(txt, 50);
    log(line);
    if (type.indexOf("Shell") >= 0) shells.push(type + " → " + classOf(node).getName());
    if (depth >= 6) return;
    var kids = null;
    try { kids = call(node, "getChildren"); } catch (e) { return; }
    if (kids === null) return;
    var n = call(kids, "getLength");
    for (var k = 0; k < n; k++) walk(call(kids, "elementAt", k), depth + 1);
  }
  try { walk(call(ses, "findById", "wnd[0]"), 0); } catch (e) { log("tree walk ERROR " + e); }
  log("--- shells/controls on screen (grid/tree/textedit support check):");
  if (shells.length === 0) log("  none on this screen – rerun on SE16N result / SE80 tree / an ALV list");
  for (var s = 0; s < shells.length; s++) log("  " + shells[s]);

  // ---- 6. Can a background thread touch the GUI? --------------------------
  var Runnable = Java.type("java.lang.Runnable");
  var result = { v: "timeout after 3s (call blocked – needs GUI thread)" };
  var th = new (Java.type("java.lang.Thread"))(new Runnable({ run: function () {
    try { result.v = "OK – transaction=" + call(call(ses, "getInfo"), "getTransaction"); }
    catch (e) { result.v = "EXCEPTION " + e; }
  }}));
  th.setDaemon(true);
  th.start();
  th.join(3000);
  log("background-thread access: " + result.v);

  safe("invokeAndWait/EDT access", function () {
    var SU = Java.type("javax.swing.SwingUtilities");
    if (SU.isEventDispatchThread()) return "skipped (script already on EDT)";
    var r = { v: "not run" };
    SU.invokeAndWait(new Runnable({ run: function () {
      try { r.v = "OK – transaction=" + call(call(ses, "getInfo"), "getTransaction"); }
      catch (e) { r.v = "EXCEPTION " + e; }
    }}));
    return r.v;
  });
}

// ---- 7. Can the script open a loopback socket? ----------------------------
safe("loopback ServerSocket", function () {
  var ss = new (Java.type("java.net.ServerSocket"))(0, 1, Java.type("java.net.InetAddress").getLoopbackAddress());
  var p = ss.getLocalPort();
  ss.close();
  return "OK (port " + p + " opened and closed)";
});

log("call paths used: direct JS=" + path.js + ", reflection=" + path.refl);

// ---- write report ---------------------------------------------------------
var home = Java.type("java.lang.System").getProperty("user.home");
var file = home + "/sapgui-java-smoke-test.txt";
try {
  var bytes = new (Java.type("java.lang.String"))(out.join("\n") + "\n").getBytes("UTF-8");
  Java.type("java.nio.file.Files").write(Java.type("java.nio.file.Paths").get(file), bytes);
} catch (e) { file = "WRITE FAILED: " + e; }

try {
  Java.type("javax.swing.JOptionPane").showMessageDialog(null,
    "Smoke test v2 finished.\n" + out.length + " lines written to\n" + file);
} catch (e) { print(out.join("\n")); }
