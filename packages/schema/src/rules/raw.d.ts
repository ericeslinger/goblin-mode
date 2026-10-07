// Vite's ?raw import, used by specs to read files at the repo root.
declare module '*?raw' {
  const text: string;
  export default text;
}
