"""H3 uses the same authenticated durable Worker protocol as LTX."""
import os, pathlib, signal, sys, threading
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'video'))
from worker import Engine, Handler
from http.server import ThreadingHTTPServer
from config import ROOT, describe, validate_request, snapshot

if __name__=='__main__':
    root=pathlib.Path(os.environ.get('DREAMER_H3_DATA',ROOT/'.local/h3-worker'))
    engine=Engine(root,ROOT/'workers/h3/run.py',describe,validate_request,snapshot,timeout=10800)
    server=ThreadingHTTPServer(('127.0.0.1',int(os.environ.get('DREAMER_H3_PORT','4329'))),Handler)
    server.engine=engine
    inference=threading.Thread(target=engine.loop);inference.start()
    threading.Thread(target=engine.heartbeat,daemon=True).start()
    def stop(*_):
        engine.close();threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    print(f'H3 worker listening on loopback port {server.server_port}',flush=True)
    try: server.serve_forever()
    finally: engine.close();inference.join();server.server_close()
