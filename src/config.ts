/**
 * Origin resolution — maps the origin host from the URL path to the
 * actual upstream Git HTTP URL.
 *
 * URL scheme: https://gitdelivr.net/<origin>/<owner>/<repo>/...
 *
 * Examples:
 *   /github.com/GNOME/gtk/info/refs       → https://github.com/GNOME/gtk.git
 *   /gitlab.gnome.org/GNOME/gtk/info/refs  → https://gitlab.gnome.org/GNOME/gtk.git
 *   /codeberg.org/forgejo/forgejo/info/refs → https://codeberg.org/forgejo/forgejo.git
 */

export function resolveOrigin(origin: string, owner: string, repo: string): string {
  // Always use HTTPS to upstream
  return `https://${origin}/${owner}/${repo}.git`;
}

/**
 * Build the full upstream URL for a specific git endpoint.
 */
export function originEndpoint(originUrl: string, gitPath: string, query?: string): string {
  const url = new URL(originUrl);
  url.pathname += gitPath;
  if (query) {
    const extra = new URLSearchParams(query);
    for (const [key, value] of extra.entries()) {
      url.searchParams.append(key, value);
    }
  }
  return url.toString();
}
