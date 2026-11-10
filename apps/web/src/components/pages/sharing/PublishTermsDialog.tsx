// FILE: PublishTermsDialog.tsx
// Purpose: The notice shown once before the first 站点 is published on this Moss.
// Layer: Space sharing (owned by sharing)
// Why: A published site is served from a Moss domain to people the owner may not know, so the
//      owner confirms once that they are responsible for what they publish.

import { Button } from "../../ui/button";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";

const POINTS = [
  "站点会通过 Moss 的分享服务对外提供，按你选择的可见性，可能被你不认识的人看到。",
  "请只发布你有权公开的内容，不要发布他人的隐私、账号密钥或违法信息。",
  "访客看到的是发布时的版本。你可以随时更新、改为仅自己可见，或取消发布。",
  "发布需要登录 Moss 账号，站点会记在这个账号名下；违反使用规则的站点可能被停止访问。",
];

export function PublishTermsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAccept: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>发布前请确认</AlertDialogTitle>
          <AlertDialogDescription render={<div />}>
            <ul className="mt-1 flex list-disc flex-col gap-1.5 pl-4 text-ui-sm">
              {POINTS.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button size="sm" variant="ghost" onClick={() => props.onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" onClick={props.onAccept}>
            我已了解，继续发布
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
