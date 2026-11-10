// แทน next/server ในเทสต์ route
/** res.cookies.set(...) เหมือน Next: เขียนเป็น Set-Cookie header */
function withCookies(res) {
  Object.defineProperty(res, "cookies", {
    value: {
      set(name, value, opts = {}) {
        const parts = [`${name}=${value}`];
        if (opts.path) parts.push(`Path=${opts.path}`);
        if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
        if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
        res.headers.append("Set-Cookie", parts.join("; "));
      },
    },
  });
  return res;
}

export class NextResponse extends Response {
  static json(body, init) {
    return withCookies(new Response(JSON.stringify(body), { ...init, headers: { "Content-Type": "application/json", ...init?.headers } }));
  }
}
export const after = (fn) => { fn(); };
