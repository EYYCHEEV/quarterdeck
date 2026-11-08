type Page = Pick<Document, "location" | "body" | "createElement">;

export type Pages = {
  goTo: (url: string) => void;
  postForm: (action: string, fields: Record<string, string>) => void;
};

export function goTo(url: string, doc: Page = document): void {
  doc.location.assign(url);
}

export function postForm(action: string, fields: Record<string, string>, doc: Page = document): void {
  const form = doc.createElement("form");
  form.method = "post";
  form.action = action;
  for (const [name, value] of Object.entries(fields)) {
    const field = doc.createElement("input");
    field.type = "hidden";
    field.name = name;
    field.value = value;
    form.append(field);
  }
  doc.body.append(form);
  form.submit();
}
