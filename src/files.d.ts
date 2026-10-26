// `import x from "./addon.node" with { type: "file" }` gives the path Bun embeds in the binary.
declare module "*.node" {
  const path: string
  export default path
}
