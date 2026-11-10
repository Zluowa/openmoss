import type { SVGProps } from "react";
import {
  ArrowDownIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ArrowUpIcon,
  ClockIcon,
  UsersIcon,
  StopIcon,
} from "~/lib/icons";
// Keep upstream sizing props while rendering the shared Moss icon family.
const adapt =
  (Icon: typeof CheckIcon) =>
  ({
    size = 16,
    absoluteStrokeWidth: _,
    ...props
  }: SVGProps<SVGSVGElement> & { size?: number; absoluteStrokeWidth?: boolean }) => (
    <Icon {...props} style={{ width: size, height: size, ...props.style }} />
  );
export const ArrowDown = adapt(ArrowDownIcon),
  Check = adapt(CheckIcon),
  ChevronDown = adapt(ChevronDownIcon),
  ChevronRight = adapt(ChevronRightIcon),
  ArrowUp = adapt(ArrowUpIcon),
  Clock = adapt(ClockIcon),
  Users = adapt(UsersIcon),
  Square = adapt(StopIcon);
