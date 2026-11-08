export async function readText(response: Response, limit: number, byteLimit = false): Promise<{ text: string; cut: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", cut: false };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (text.length <= limit && (!byteLimit || bytes <= limit)) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      const available = byteLimit ? Math.min(value.length, limit + 1 - bytes) : value.length;
      bytes += value.byteLength;
      let offset = 0;
      while (offset < available && text.length <= limit) {
        const end = Math.min(available, offset + limit + 1 - text.length);
        text += decoder.decode(value.subarray(offset, end), { stream: true });
        offset = end;
      }
    }
    return { text: text.slice(0, limit), cut: byteLimit ? bytes > limit : text.length > limit };
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export async function fetchText(url: string, limit: number): Promise<{ text: string; cut: boolean }> {
  return readText(await fetch(url, { redirect: "error", credentials: "same-origin" }), limit);
}
