import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../../lib/api';
import { Avatar, Icon } from '../ui';
import { clockTime, linkify } from '../../lib/format';
import type { RoomActions } from '../../hooks/useRoom';

interface Props {
  messages: ChatMessage[];
  typingUsers: Record<string, string>;
  myUserId: string;
  actions: RoomActions;
}

const GROUP_WINDOW_MS = 4 * 60 * 1000;

export function ChatPanel({ messages, typingUsers, myUserId, actions }: Props) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const typingSent = useRef(false);
  const typingTimer = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => () => window.clearTimeout(typingTimer.current), []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    actions.sendChat(body);
    setDraft('');
    stickToBottom.current = true;
    if (typingSent.current) {
      typingSent.current = false;
      actions.setTyping(false);
    }
  };

  const onDraftChange = (value: string) => {
    setDraft(value);
    if (value && !typingSent.current) {
      typingSent.current = true;
      actions.setTyping(true);
    }
    window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => {
      if (typingSent.current) {
        typingSent.current = false;
        actions.setTyping(false);
      }
    }, 2500);
  };

  const typingNames = Object.entries(typingUsers)
    .filter(([id]) => id !== myUserId)
    .map(([, name]) => name);

  return (
    <div className="side-body">
      <div className="scroll-y" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-list">
          {messages.length === 0 && (
            <div className="tiny faint" style={{ padding: 14, textAlign: 'center' }}>
              No messages yet. Say hi 👋
            </div>
          )}
          {messages.map((msg, i) => {
            if (msg.kind === 'system') {
              return (
                <div className="chat-system" key={msg.id}>
                  {msg.body}
                </div>
              );
            }
            const prev = messages[i - 1];
            const grouped =
              prev &&
              prev.kind === 'chat' &&
              prev.userId === msg.userId &&
              msg.createdAt - prev.createdAt < GROUP_WINDOW_MS;

            return (
              <div className={`chat-msg${grouped ? ' grouped' : ''}`} key={msg.id}>
                {grouped ? (
                  <span className="spacer" />
                ) : (
                  <Avatar name={msg.displayName || '?'} color={msg.avatarColor || '#666'} />
                )}
                <div className="chat-body">
                  {!grouped && (
                    <div className="row" style={{ gap: 7, alignItems: 'baseline' }}>
                      <span className="chat-name" style={{ color: msg.avatarColor || undefined }}>
                        {msg.displayName || 'Unknown'}
                      </span>
                      <span className="chat-time">{clockTime(msg.createdAt)}</span>
                    </div>
                  )}
                  <div className="chat-text">
                    {linkify(msg.body).map((part, idx) =>
                      part.type === 'link' ? (
                        <a key={idx} href={part.value} target="_blank" rel="noreferrer noopener">
                          {part.value}
                        </a>
                      ) : (
                        <span key={idx}>{part.value}</span>
                      )
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="side-foot">
        <div className="typing-line">
          {typingNames.length === 1
            ? `${typingNames[0]} is typing…`
            : typingNames.length > 1
              ? `${typingNames.length} people are typing…`
              : ''}
        </div>
        <div className="chat-compose">
          <textarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Message the room…"
            rows={1}
            maxLength={2000}
          />
          <button className="btn primary icon" onClick={send} disabled={!draft.trim()} aria-label="Send">
            <Icon name="next" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
