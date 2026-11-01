// แทน next/server ในเทสต์ route
export class NextResponse extends Response {
  static json(body, init) {
    return new Response(JSON.stringify(body), { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  }
}
export const after = (fn) => { fn(); };
