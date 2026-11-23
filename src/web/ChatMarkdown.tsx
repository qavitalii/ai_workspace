import type { Element, Root } from "hast";
import { ArrowLeftRight, Download } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const generatedName = /^generated-image-[0-9a-f-]{36}\.(png|jpg|webp|gif)$/i;
const downloadLabel =
  /^Download generated image(?: \d+)? \((?:PNG|JPG|WEBP|GIF)\)$/;

function workspaceImagePath(href: unknown, chatId: string) {
  if (typeof href !== "string") return;
  const endpoint = `/api/chats/${chatId}/file?`;
  const local = /^(?:sandbox:|file:\/\/)?\/workspace\/(.+)$/.exec(href);
  let path: string | null = null;
  if (href.startsWith(endpoint))
    path = new URLSearchParams(
      href.slice(endpoint.length).split("#", 1)[0],
    ).get("path");
  else if (local) {
    try {
      path = decodeURIComponent(local[1]);
    } catch {
      return;
    }
  }
  if (
    path &&
    path.length <= 1000 &&
    !/[\\\u0000-\u001f\u007f]/.test(path) &&
    !path.split("/").some((part) => ["", ".", "..", ".git"].includes(part)) &&
    /\.(png|jpe?g|webp|gif)$/i.test(path)
  )
    return path;
}

function workspaceFileUrl(chatId: string, path: string) {
  return `/api/chats/${chatId}/file?path=${encodeURIComponent(path)}`;
}

function workspaceImagePreviews(chatId: string) {
  return (tree: Root) => {
    const images = new Map<string, string>();
    function rewrite(parent: Root | Element) {
      for (let i = 0; i < parent.children.length;) {
        const node = parent.children[i];
        if (node.type !== "element") {
          i++;
          continue;
        }
        const path =
          node.tagName === "a"
            ? workspaceImagePath(node.properties.href, chatId)
            : node.tagName === "img"
              ? workspaceImagePath(node.properties.src, chatId)
              : undefined;
        if (path) {
          const alt = node.properties.alt;
          if (!images.has(path) || (typeof alt === "string" && alt.trim()))
            images.set(path, typeof alt === "string" ? alt.trim() : "");
          const label = node.children[0];
          const isGeneratedDownload =
            parent.type === "element" &&
            parent.tagName === "p" &&
            parent.children.length === 1 &&
            generatedName.test(path) &&
            node.children.length === 1 &&
            label.type === "text" &&
            downloadLabel.test(label.value);
          if (node.tagName === "img" || isGeneratedDownload) {
            parent.children.splice(i, 1);
            continue;
          }
          node.properties.href = workspaceFileUrl(chatId, path) + "&inline=1";
        }
        rewrite(node);
        if (
          (node.tagName === "p" || node.tagName === "a") &&
          !node.children.length
        ) {
          parent.children.splice(i, 1);
          continue;
        }
        i++;
      }
    }
    rewrite(tree);
    let index = 0;
    for (const [path, alt] of images) {
      const file = path.split("/").at(-1)!;
      const number = ++index;
      const description =
        alt || (generatedName.test(file) ? "Generated image" : file);
      tree.children.push({
        type: "element",
        tagName: "figure",
        properties: {
          dataWorkspaceFile: workspaceFileUrl(chatId, path),
          dataWorkspaceAlt: description,
          dataWorkspaceLabel:
            images.size > 1
              ? !alt && generatedName.test(file)
                ? `Generated image ${number}`
                : `${description} (image ${number})`
              : description,
          dataWorkspaceFormat: file
            .slice(file.lastIndexOf(".") + 1)
            .toUpperCase(),
        },
        children: [],
      });
    }
  };
}

function WorkspaceImage({
  file,
  alt,
  format,
  label,
}: {
  file: string;
  alt: string;
  format: string;
  label: string;
}) {
  const [unavailable, setUnavailable] = useState(false);
  const original = file + "&inline=1";
  return (
    <figure className="chat-image-preview">
      {unavailable ? (
        <div className="chat-image-unavailable" role="status">
          Image preview unavailable
        </div>
      ) : (
        <a
          className="chat-image-original"
          href={original}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${label} in a new tab`}
        >
          <img
            src={original}
            alt={alt}
            loading="lazy"
            decoding="async"
            onError={() => setUnavailable(true)}
          />
        </a>
      )}
      <figcaption>
        <a
          className="chat-image-download"
          href={file}
          download
          aria-label={`Download ${format} — ${label}`}
        >
          <Download size={15} aria-hidden="true" /> Download {format}
        </a>
      </figcaption>
    </figure>
  );
}

function MarkdownTable(props: ComponentProps<"table">) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current!;
    const table = tableRef.current!;
    const update = () =>
      setOverflowing(scroller.scrollWidth > scroller.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    observer.observe(table);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="chat-table">
      {overflowing && (
        <div className="chat-table-hint" aria-hidden="true">
          <ArrowLeftRight size={13} />
          Scroll to see all columns
        </div>
      )}
      <div
        ref={scrollRef}
        className="chat-table-scroll"
        role={overflowing ? "region" : undefined}
        aria-label={overflowing ? "Scrollable table" : undefined}
        tabIndex={overflowing ? 0 : undefined}
        onKeyDown={(event) => {
          if (
            !overflowing ||
            event.target !== event.currentTarget ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
          )
            return;
          event.preventDefault();
          event.currentTarget.scrollLeft += event.key === "ArrowLeft" ? -40 : 40;
        }}
      >
        <table {...props} ref={tableRef} />
      </div>
    </div>
  );
}

const components: Components = {
  a: ({ children, node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ node, ...props }) => <MarkdownTable {...props} />,
  img: ({ src, alt }) =>
    src && /^\/api\/attachments\/[0-9a-f-]{36}$/i.test(src) ? (
      <img src={src} alt={alt} />
    ) : (
      <span>[Image: {alt}]</span>
    ),
  figure: ({ node, children }) => {
    const file = node?.properties.dataWorkspaceFile;
    if (typeof file !== "string") return <figure>{children}</figure>;
    return (
      <WorkspaceImage
        key={file}
        file={file}
        alt={String(node?.properties.dataWorkspaceAlt)}
        format={String(node?.properties.dataWorkspaceFormat)}
        label={String(node?.properties.dataWorkspaceLabel)}
      />
    );
  },
};

export function ChatMarkdown({
  text,
  chatId,
}: {
  text: string;
  chatId?: string;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={chatId ? [[workspaceImagePreviews, chatId]] : undefined}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
