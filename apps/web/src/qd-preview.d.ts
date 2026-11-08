declare const __QD_PREVIEW__: boolean;
declare const __QD_FIXTURES__: boolean;
declare const __QD_SOURCE__: "example" | "server";
declare const __QD_CHAT__: "on" | "off";
declare module "*.html" {
  const text: string;
  export default text;
}
