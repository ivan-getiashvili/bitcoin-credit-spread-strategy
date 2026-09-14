// Wrangler bundles the dashboard page as a text module (see "rules" in wrangler.jsonc).
declare module '*.html' {
  const content: string;
  export default content;
}
