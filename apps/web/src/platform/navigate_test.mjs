import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { goTo, postForm } = await loadTs("src/platform/navigate.ts");

function fakeDocument() {
  const made = [];
  const node = (tag) => ({ tag, children: [], submitted: 0, append(child) { this.children.push(child); }, submit() { this.submitted += 1; } });
  const body = node("body");
  const visits = [];
  const doc = {
    body,
    location: { assign: (url) => visits.push(url) },
    createElement(tag) {
      const element = node(tag);
      made.push(element);
      return element;
    },
  };
  return { doc, made, body, visits };
}

test("going to a page is one navigation of the whole page to that address", () => {
  const { doc, made, visits } = fakeDocument();
  goTo("/captain/login", doc);
  assert.deepEqual([visits, made.length], [["/captain/login"], 0]);
});

test("a form post is one top-level POST form to its address, with one hidden field each and nothing else, added to the page and sent once", () => {
  const { doc, made, body, visits } = fakeDocument();
  postForm("/captain/logout", { csrf: "token-1" }, doc);
  const [form] = body.children;
  assert.deepEqual(
    [body.children.length, made.length, form.tag, form.method, form.action, form.children.length, form.submitted, visits.length],
    [1, 2, "form", "post", "/captain/logout", 1, 1, 0],
  );
  const [field] = form.children;
  assert.deepEqual({ tag: field.tag, type: field.type, name: field.name, value: field.value }, { tag: "input", type: "hidden", name: "csrf", value: "token-1" });
});
