"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function RichText({ children }: { children: string }) {
  return (
    <div className="rich-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: label, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {label}
            </a>
          )
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
