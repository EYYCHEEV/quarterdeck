export function countList(text) {
  const pairs = text
    .split("\n")
    .slice(1)
    .filter((line) => line !== "");
  const none = pairs.filter((line) => line.endsWith(" none")).length;
  return { pairs: pairs.length, sha512: pairs.length - none, none };
}
