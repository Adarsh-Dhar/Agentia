interface CodeEditorProps {
  content: string | object | undefined;
}

export function CodeEditor({ content }: CodeEditorProps) {
  let displayContent: string;
  if (content === undefined) {
    displayContent = "// Click Generate Bot to see files";
  } else if (typeof content === "object") {
    displayContent = JSON.stringify(content, null, 2);
  } else {
    displayContent = content;
  }
  return (
    <div className="flex-1 overflow-auto bg-[#020617] p-4">
      <pre className="text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap break-all">
        <code>{displayContent}</code>
      </pre>
    </div>
  );
}
