// sapgui-java-mcp bridge agent – starts scripts/bridge.js inside SAP GUI for Java without the
// Scripting menu.
//
//   premain   : -javaagent:bridge-agent.jar=<path to bridge.js>   (GUI start, see scripts/sapgui-java-with-bridge)
//   agentmain : attach to a running GUI:  java -jar bridge-agent.jar <pid> <path to bridge.js>
//
// A daemon thread waits until SAP GUI's GuiApplication exists (its classes come from SAP's own class
// loader, found via Instrumentation.getAllLoadedClasses()), then runs the bridge through the GUI's own
// script interpreter – GuiJavaScriptEventHandler.createGlobalHandler(app) +
// new GuiJavaScriptInterpreter(handler, app, null, null).processScript(text) – the same path as the
// Scripting menu, so the script gets the preset 'application' object.
// Output goes to ~/.sapgui-java-mcp/agent.log only: guilogon reads stdout of a JVM that also gets this
// agent ("getopts").
import java.lang.instrument.Instrumentation;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;

public final class BridgeAgent {
  private static final String APP = "com.sap.platin.base.application.GuiApplication";
  private static final Path DIR = Paths.get(System.getProperty("user.home"), ".sapgui-java-mcp");

  public static void premain(String args, Instrumentation inst) { start(args, inst, false); }
  public static void agentmain(String args, Instrumentation inst) { start(args, inst, true); }

  private static void start(String script, Instrumentation inst, boolean attached) {
    Thread t = new Thread(() -> run(script, inst, attached), "sapgui-java-mcp-agent");
    t.setDaemon(true);
    t.start();
  }

  private static void run(String script, Instrumentation inst, boolean attached) {
    try {
      if (script == null || script.isBlank()) { log("no bridge.js path given (-javaagent:bridge-agent.jar=<path>)"); return; }
      Path file = Paths.get(script).toAbsolutePath();
      long deadline = System.currentTimeMillis() + 10 * 60_000;     // wait up to 10 min for the GUI
      while (System.currentTimeMillis() < deadline) {
        Class<?> appCls = findLoaded(inst, APP);
        Object app = appCls == null ? null : appCls.getMethod("currentApplication").invoke(null);
        if (app != null) {
          if (!attached) Thread.sleep(3000);                           // let the GUI finish its start-up
          runBridge(appCls, app, file);
          return;
        }
        Thread.sleep(1000);
      }
      log("gave up: " + APP + " did not appear within 10 min (not a SAP GUI JVM?)");
    } catch (Throwable e) {
      log("failed: " + e);
      Throwable c = e.getCause();
      while (c != null) { log("  caused by: " + c); c = c.getCause(); }
    }
  }

  private static void runBridge(Class<?> appCls, Object app, Path file) throws Exception {
    ClassLoader l = appCls.getClassLoader();
    // GuiJavaScriptInterpreter.init() does new ScriptEngineManager(), which searches the thread's
    // context class loader – Nashorn lives in the GUI's loader, not in the system one
    Thread.currentThread().setContextClassLoader(l);
    Class<?> ehCls = l.loadClass("com.sap.platin.base.scripting.javaScript.GuiJavaScriptEventHandler");
    Class<?> ipCls = l.loadClass("com.sap.platin.base.scripting.javaScript.GuiJavaScriptInterpreter");
    Class<?> conCls = l.loadClass("com.sap.platin.base.connection.GuiConnection");
    Class<?> sesCls = l.loadClass("com.sap.platin.base.session.GuiSessionI");
    Object handler = ehCls.getMethod("createGlobalHandler", appCls).invoke(null, app);
    Object interp = ipCls.getConstructor(ehCls, appCls, conCls, sesCls).newInstance(handler, app, null, null);
    String text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
    System.setProperty("sapgui-java-mcp.autostart", "X");          // bridge: no start dialog
    System.setProperty("sapgui-java-mcp.script", file.toString()); // bridge: path for /reload
    Object r = ipCls.getMethod("processScript", String.class).invoke(interp, text);
    log("bridge started from " + file + (r != null && !String.valueOf(r).isEmpty() ? " – interpreter said: " + r : ""));
  }

  private static Class<?> findLoaded(Instrumentation inst, String name) {
    for (Class<?> c : inst.getAllLoadedClasses()) if (name.equals(c.getName())) return c;
    return null;
  }

  private static void log(String msg) {
    try {
      Files.createDirectories(DIR);
      Files.write(DIR.resolve("agent.log"), (Instant.now() + " " + msg + "\n").getBytes(StandardCharsets.UTF_8),
          StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    } catch (Exception ignored) { }
  }

  /** Attach to a running SAP GUI: java -jar bridge-agent.jar <pid> <path to bridge.js> */
  public static void main(String[] a) throws Exception {
    if (a.length < 2) { System.err.println("usage: java -jar bridge-agent.jar <pid> <path to bridge.js>"); System.exit(2); }
    Path jar = Paths.get(BridgeAgent.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    com.sun.tools.attach.VirtualMachine vm = com.sun.tools.attach.VirtualMachine.attach(a[0]);
    try { vm.loadAgent(jar.toString(), Paths.get(a[1]).toAbsolutePath().toString()); }
    finally { vm.detach(); }
    System.out.println("agent loaded into " + a[0] + " – see ~/.sapgui-java-mcp/agent.log");
  }
}
