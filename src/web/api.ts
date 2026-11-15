export async function api<T = any>(
  url: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const r = await fetch("/api" + url, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers:
      body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
export function upload(
  chatId: string,
  file: File,
  clientId: string,
  onProgress: (n: number) => void,
) {
  return new Promise<any>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", `/api/chats/${chatId}/attachments?client_id=${clientId}`);
    x.upload.onprogress = (e) =>
      onProgress(
        e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : 0,
      );
    x.onload = () => {
      try {
        const d = JSON.parse(x.responseText);
        x.status < 300
          ? resolve(d)
          : reject(new Error(d.error || "Upload failed"));
      } catch {
        reject(new Error("Invalid server response"));
      }
    };
    x.onerror = () =>
      reject(new Error("Connection interrupted. Please retry the upload."));
    const fd = new FormData();
    fd.append("file", file);
    x.send(fd);
  });
}
export const socketUrl = (path: string) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api${path}`;
