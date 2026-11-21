import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChatMarkdown } from "../src/web/ChatMarkdown";

const chatId = "4b39a1f2-1d99-44df-b7ae-8a66c04c93ee";
const name = "generated-image-6efa161f-2eab-463a-968b-11b3506be1bf.png";
const route = `/api/chats/${chatId}/file?path=`;
const generated = `${route}${name}`;

function render(text: string, assistant = true) {
  return renderToStaticMarkup(
    createElement(ChatMarkdown, {
      text,
      chatId: assistant ? chatId : undefined,
    }),
  );
}

it("shows one preview for duplicate saved links and keeps a separate download", () => {
  const markup = render(
    `Ready. [Open the sunset](${generated})\n\n[Download generated image (PNG)](${generated})`,
  );
  expect(markup.match(/class="chat-image-preview"/g)).toHaveLength(1);
  expect(markup).toContain(
    `href="${generated}&amp;inline=1" target="_blank" rel="noopener noreferrer">Open the sunset`,
  );
  expect(markup).toContain(`src="${generated}&amp;inline=1"`);
  expect(markup).toContain(`href="${generated}" download=""`);
  expect(markup).not.toContain("Download generated image (PNG)");
});

it("previews links and image syntax from workspace paths while keeping alt text", () => {
  const resource = "results/Warsaw%20sunset.png";
  const markup = render(
    `[Open](sandbox:/workspace/${resource})\n\n![Over the Vistula](/workspace/${resource})\n\n[Other](file:///workspace/results/other.webp)`,
  );
  expect(markup.match(/class="chat-image-preview"/g)).toHaveLength(2);
  expect(markup).toContain(
    `${route}results%2FWarsaw%20sunset.png&amp;inline=1`,
  );
  expect(markup).toContain('alt="Over the Vistula"');
  expect(markup).toContain(
    'aria-label="Open Over the Vistula (image 1) in a new tab"',
  );
  expect(markup).toContain('aria-label="Download WEBP — other.webp (image 2)"');
  expect(markup).toContain(`${route}results%2Fother.webp&amp;inline=1`);
});

it("leaves external links, another chat, text files and code examples alone", () => {
  const other = generated.replace(
    chatId,
    "ba566f62-f439-483f-8114-08abbc96fac5",
  );
  const external = "https://example.test" + generated;
  const paths = [
    other,
    external,
    route + "report.txt",
    route + "..%2Foutside.png",
    route + "%2Ftmp%2Ffile.png",
    route + ".git%2Fsecret.png",
  ];
  const markup = render(
    paths.map((href) => `[File](${href})`).join("\n\n") +
      `\n\n\`[An example](${generated})\``,
  );
  expect(markup).not.toContain("chat-image-preview");
  for (const href of paths) expect(markup).toContain(`href="${href}"`);
  expect(markup).toContain(`<code>[An example](${generated})</code>`);
  expect(render(`[File](${generated})`, false)).not.toContain(
    "chat-image-preview",
  );
  const attachment = "/api/attachments/ba566f62-f439-483f-8114-08abbc96fac5";
  expect(render(`![Other chat](${other}&inline=1)`)).not.toContain("<img");
  expect(render(`![Attached image](${attachment})`)).toContain(
    `<img src="${attachment}" alt="Attached image"`,
  );
});
