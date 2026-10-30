import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../../src/components/ComposerPromptEditor";

function ComposerFixture() {
  const editor = useRef<ComposerPromptEditorHandle>(null);
  const [draft, setDraft] = useState({ value: "", cursor: 0 });
  const [messages, setMessages] = useState<string[]>([]);
  const send = () => {
    const text = editor.current!.readSnapshot().value;
    setMessages((previous) => [...previous, text]);
    setDraft({ value: "", cursor: 0 });
  };
  return (
    <main>
      <h1>Electron native clipboard regression</h1>
      {messages.map((message, index) => (
        <pre data-testid="sent-user-message" key={index}>
          {message}
        </pre>
      ))}
      <ComposerPromptEditor
        ref={editor}
        {...draft}
        terminalContexts={[]}
        disabled={false}
        placeholder="Prompt"
        onRemoveTerminalContext={() => {}}
        onCollapsePastedText={() => {
          throw new Error("Short paste must not collapse");
        }}
        onPaste={() => {}}
        onChange={(value, cursor) => setDraft({ value, cursor })}
        onCommandKeyDown={(key, event) => {
          if (key !== "Enter" || event.shiftKey || event.isComposing) return false;
          send();
          return true;
        }}
      />
      <button onClick={send}>Send</button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<ComposerFixture />);
