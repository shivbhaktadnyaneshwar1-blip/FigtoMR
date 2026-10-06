type Props = {
  readonly text: string;
  readonly instant?: boolean;
};

/** Assistant chat reply with optional typewriter effect (CSS-only). */
export function TypedChatReply({ text, instant = false }: Props) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  return (
    <div className="chat-bubble chat-assistant chat-card chat-typed">
      <strong>Studio</strong>
      <p className={`chat-typed-body${instant ? ' is-instant' : ''}`}>{trimmed}</p>
    </div>
  );
}
