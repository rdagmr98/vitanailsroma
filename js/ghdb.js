(function () {
  const cfg = () => window.VITA_GH || {};
  const api = "https://api.github.com";

  function headers() {
    const t = cfg().token;
    if (!t) throw new Error("noapi");
    return {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + t,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  function fileUrl(name) {
    const c = cfg();
    return `${api}/repos/${c.owner}/${c.repo}/contents/${c.path}/${name}`;
  }

  function b64ToUtf8(b64) {
    const bin = atob(String(b64).replace(/\n/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function getFile(name) {
    const r = await fetch(fileUrl(name), { headers: headers() });
    if (r.status === 404) return { data: null, sha: "" };
    if (!r.ok) throw new Error("get:" + name);
    const j = await r.json();
    return { data: JSON.parse(b64ToUtf8(j.content)), sha: j.sha };
  }

  async function putFile(name, data, sha, message) {
    const body = {
      message: message || ("vita: " + name),
      content: utf8ToB64(JSON.stringify(data, null, 2) + "\n"),
    };
    if (sha) body.sha = sha;
    const r = await fetch(fileUrl(name), {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 409) {
      const err = new Error("conflict");
      err.code = 409;
      throw err;
    }
    if (!r.ok) throw new Error("put:" + name);
    const j = await r.json();
    return j.content && j.content.sha;
  }

  async function writeWithRetry(name, mutator, message, tries = 6) {
    for (let i = 0; i < tries; i++) {
      const cur = await getFile(name);
      const base = cur.data == null ? null : JSON.parse(JSON.stringify(cur.data));
      const next = mutator(base);
      try {
        await putFile(name, next, cur.sha, message);
        return next;
      } catch (e) {
        if (e.code === 409 || e.message === "conflict") {
          await new Promise(r => setTimeout(r, 200 + i * 300));
          continue;
        }
        throw e;
      }
    }
    throw new Error("conflict");
  }

  window.VitaGhDb = { getFile, putFile, writeWithRetry, headers, fileUrl };
})();
