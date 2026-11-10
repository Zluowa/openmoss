// FILE: PageShareActivity.tsx
// Purpose: 动态 tab of the share dialog: comments from people outside this Moss (with the
//          owner's replies) and the audit of who opened, commented, asked for access, and what
//          the owner changed.
// Layer: Space sharing (owned by sharing)

import type { PageId, SpaceId } from "@moss/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ensurePageSharingApi } from "~/nativeApi";
import { useTranslation } from "~/localization";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import {
  actorLabel,
  describePageSharingError,
  eventLabel,
  formatRelativeTime,
  guestCommentAuthorLabel,
  pageSharingQueryKeys,
} from "./pageSharing.logic";

export function PageShareActivity(props: {
  readonly account: string;
  readonly scopeSpaceId: SpaceId | null;
  readonly pageId: PageId;
}) {
  const translation = useTranslation();
  const { account, scopeSpaceId, pageId } = props;
  const client = useQueryClient();
  const queryKey = pageSharingQueryKeys.activity(account, scopeSpaceId, pageId);
  const query = useQuery({
    queryKey,
    queryFn: () => ensurePageSharingApi().activity({ scopeSpaceId, pageId }),
    refetchInterval: 15_000,
  });
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (query.isPending) {
    return <p className="py-6 text-center text-ui-sm text-muted-foreground">正在读取动态…</p>;
  }
  if (query.isError) {
    return (
      <p role="alert" className="py-6 text-ui-sm text-destructive">
        {describePageSharingError(query.error).message}
      </p>
    );
  }
  const { comments, events } = query.data;
  const send = async () => {
    const content = reply.trim();
    if (content === "") return;
    setSending(true);
    setError(null);
    try {
      client.setQueryData(
        queryKey,
        await ensurePageSharingApi().reply({ scopeSpaceId, pageId, content }),
      );
      setReply("");
    } catch (cause) {
      setError(describePageSharingError(cause).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-ui-xs font-medium text-muted-foreground">访客评论</h3>
        {comments.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">还没有访客评论。</p>
        ) : (
          <ol aria-label="访客评论" className="flex flex-col gap-3">
            {comments.map((comment) => (
              <li key={comment.id} className="flex flex-col gap-0.5">
                <div className="text-ui-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {guestCommentAuthorLabel(comment, translation)}
                  </span>
                  {" · "}
                  {formatRelativeTime(comment.createdAt)}
                </div>
                <p className="whitespace-pre-wrap text-ui-sm text-foreground">{comment.content}</p>
              </li>
            ))}
          </ol>
        )}
        {comments.length > 0 ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Textarea
              aria-label="回复访客"
              placeholder="回复访客，他们打开页面就能看到"
              value={reply}
              maxLength={4000}
              onChange={(event) => setReply(event.target.value)}
              className="min-h-16"
            />
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={sending || reply.trim() === ""}>
                回复
              </Button>
            </div>
          </form>
        ) : null}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-ui-xs font-medium text-muted-foreground">访问记录</h3>
        {events.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">还没有人打开过分享的页面。</p>
        ) : (
          <ol aria-label="访问记录" className="flex flex-col gap-1.5">
            {events.map((event) => (
              <li key={event.id} className="flex items-baseline justify-between gap-3 text-ui-sm">
                <span className="min-w-0 truncate">
                  <span className="text-foreground">{actorLabel(event)}</span>{" "}
                  <span className="text-muted-foreground">{eventLabel(event.action)}</span>
                </span>
                <span className="shrink-0 text-ui-xs text-muted-foreground">
                  {formatRelativeTime(event.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
