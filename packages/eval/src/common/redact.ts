export function secretsOfUrls(urls: string[], extra: string[] = []): string[] {
  const parts = urls.flatMap((u) => {
    const url = new URL(u);
    const tail = url.pathname + url.search;
    return [u, url.href, url.origin, url.host, url.search, ...(tail !== "/" ? [tail] : [])];
  });
  parts.push(...extra);
  return [...new Set(parts.filter((p) => p.length > 0))].sort((a, b) => b.length - a.length);
}

export function redact(message: string, secrets: string[]): string {
  return secrets.reduce((text, secret) => text.split(secret).join("<redacted>"), message);
}
