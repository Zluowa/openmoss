import type { ComponentPropsWithoutRef } from "react";

type ComputerHistoryIconProps = ComponentPropsWithoutRef<"svg">;

export function ComputerHistoryChevronRightIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M7.75 4.5 13.25 10l-5.5 5.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ComputerHistoryChevronDownIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="20"
      height="21"
      viewBox="0 0 20 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M4.75 8l5.25 5.25L15.25 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ComputerHistoryPreviousIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M16.5 10H3.75M9 4.75 3.75 10 9 15.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ComputerHistoryPlusIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M10 3.5v13M3.5 10h13"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ComputerHistoryGlobeIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M2.75 10h14.5M10 2.75c1.9 1.9 3 4.4 3 7.25s-1.1 5.35-3 7.25c-1.9-1.9-3-4.4-3-7.25s1.1-5.35 3-7.25Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ComputerHistorySearchIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1" />
      <path
        d="M10.4 10.4l3.35 3.35"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ComputerHistoryRemoveIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 21 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M5.75 5.75l9.5 9.5M15.25 5.75l-9.5 9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ComputerHistoryClearSearchIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M7.75 7.75l4.5 4.5M12.25 7.75l-4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ComputerHistoryFolderIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M2.75 6.25a2 2 0 0 1 2-2h3.2a1.75 1.75 0 0 1 1.3.58l1 1.12a.5.5 0 0 0 .37.17h4.63a2 2 0 0 1 2 2v6.63a2 2 0 0 1-2 2H4.75a2 2 0 0 1-2-2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ComputerHistoryTrashIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M3.5 5.5h13M7.75 5.5V4.25a1.5 1.5 0 0 1 1.5-1.5h1.5a1.5 1.5 0 0 1 1.5 1.5V5.5M5 5.5l.7 9.6a1.75 1.75 0 0 0 1.75 1.65h5.1a1.75 1.75 0 0 0 1.75-1.65L15 5.5M8.25 9v4.25M11.75 9v4.25"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ComputerHistoryAskIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="14"
      height="12"
      viewBox="0 0 14 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M2.5 3.75H7a1.75 1.75 0 0 1 1.75 1.75v1.75A1.75 1.75 0 0 1 7 9H4.25L2.1 10.85V8.9a1.75 1.75 0 0 1-1.35-1.65V5.5A1.75 1.75 0 0 1 2.5 3.75ZM4.4 2A1.75 1.75 0 0 1 6 .95h5.5a1.75 1.75 0 0 1 1.75 1.75v2a1.75 1.75 0 0 1-1.75 1.75h-.75"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ComputerHistoryInfoIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 21 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M9.8 10.2a.7.7 0 0 1 1.4 0v3.4a.7.7 0 0 1-1.4 0Z" fill="currentColor" />
      <path d="M10.5 6.2a.95.95 0 1 1 0 1.9a.95.95 0 0 1 0-1.9Z" fill="currentColor" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.5 3a7.5 7.5 0 1 1 0 15a7.5 7.5 0 0 1 0-15Zm0 1.4a6.1 6.1 0 1 0 0 12.2a6.1 6.1 0 0 0 0-12.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ComputerHistoryBookIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="24"
      height="24"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g className="dark:hidden">
        <path
          fill="#DC7157"
          d="M2 6.25A1.75 1.75 0 0 1 3.75 4.5H9c1.2 0 2.3.5 3 1.35.7-.85 1.8-1.35 3-1.35h5.25A1.75 1.75 0 0 1 22 6.25v11.5a1.75 1.75 0 0 1-1.75 1.75H15c-1.15 0-2.2.45-3 1.2-.8-.75-1.85-1.2-3-1.2H3.75A1.75 1.75 0 0 1 2 17.75Z"
        />
        <path
          fill="#F3EFE4"
          d="M3.75 6.25H9c1.1 0 2.25.85 2.25 2v9.9c-.7-.4-1.45-.65-2.25-.65H3.75Z"
        />
        <path
          fill="#FBF7EC"
          d="M20.25 6.25H15c-1.1 0-2.25.85-2.25 2v9.9c.7-.4 1.45-.65 2.25-.65h5.25Z"
        />
      </g>
      <g className="hidden dark:inline">
        <path
          fill="#DA816B"
          d="M2 6.25A1.75 1.75 0 0 1 3.75 4.5H9c1.2 0 2.3.5 3 1.35.7-.85 1.8-1.35 3-1.35h5.25A1.75 1.75 0 0 1 22 6.25v11.5a1.75 1.75 0 0 1-1.75 1.75H15c-1.15 0-2.2.45-3 1.2-.8-.75-1.85-1.2-3-1.2H3.75A1.75 1.75 0 0 1 2 17.75Z"
        />
        <path
          fill="#EDEAE2"
          d="M3.75 6.25H9c1.1 0 2.25.85 2.25 2v9.9c-.7-.4-1.45-.65-2.25-.65H3.75Z"
        />
        <path
          fill="#FAF7F0"
          d="M20.25 6.25H15c-1.1 0-2.25.85-2.25 2v9.9c.7-.4 1.45-.65 2.25-.65h5.25Z"
        />
      </g>
    </svg>
  );
}

export function ComputerHistoryClipboardIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="24"
      height="24"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        className="dark:hidden"
        fill="#DC7157"
        d="M6.5 3.75h11a2.75 2.75 0 0 1 2.75 2.75v13a2.75 2.75 0 0 1-2.75 2.75h-11a2.75 2.75 0 0 1-2.75-2.75v-13A2.75 2.75 0 0 1 6.5 3.75Z"
      />
      <path
        className="hidden dark:inline"
        fill="#DA816B"
        d="M6.5 3.75h11a2.75 2.75 0 0 1 2.75 2.75v13a2.75 2.75 0 0 1-2.75 2.75h-11a2.75 2.75 0 0 1-2.75-2.75v-13A2.75 2.75 0 0 1 6.5 3.75Z"
      />
      <path
        fill="#FFFBFB"
        d="M7 6h10a1.25 1.25 0 0 1 1.25 1.25V19A1.25 1.25 0 0 1 17 20.25H7A1.25 1.25 0 0 1 5.75 19V7.25A1.25 1.25 0 0 1 7 6Z"
      />
      <path
        fill="#F75858"
        d="M12 7.75A2.25 2.25 0 0 1 14.25 10v.75h-1.2V10a1.05 1.05 0 0 0-2.1 0v.75h-1.2V10A2.25 2.25 0 0 1 12 7.75ZM10 10.75h4a.75.75 0 0 1 .75.75v2.75a.75.75 0 0 1-.75.75h-4a.75.75 0 0 1-.75-.75V11.5a.75.75 0 0 1 .75-.75Z"
      />
      <path
        className="dark:hidden"
        fill="#A93A20"
        d="M9.25 1.75h5.5a1 1 0 0 1 1 1v2.5a1.25 1.25 0 0 1-1.25 1.25h-5A1.25 1.25 0 0 1 8.25 5.25v-2.5a1 1 0 0 1 1-1Z"
      />
      <path
        className="hidden dark:inline"
        fill="#A9583D"
        d="M9.25 1.75h5.5a1 1 0 0 1 1 1v2.5a1.25 1.25 0 0 1-1.25 1.25h-5A1.25 1.25 0 0 1 8.25 5.25v-2.5a1 1 0 0 1 1-1Z"
      />
      <path
        fill="#9B9B9B"
        d="M8.25 16.2h7.5a.55.55 0 0 1 0 1.1h-7.5a.55.55 0 0 1 0-1.1ZM8.25 18.1h4.5a.55.55 0 0 1 0 1.1h-4.5a.55.55 0 0 1 0-1.1Z"
      />
    </svg>
  );
}

export function ComputerHistoryPersonVideoIcon(props: ComputerHistoryIconProps) {
  return (
    <svg
      width="24"
      height="24"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g className="dark:hidden">
        <path
          fill="#608DFF"
          d="M6.25 2.5h11.5a3.75 3.75 0 0 1 3.75 3.75v11.5a3.75 3.75 0 0 1-3.75 3.75H6.25a3.75 3.75 0 0 1-3.75-3.75V6.25A3.75 3.75 0 0 1 6.25 2.5Z"
        />
        <path fill="#D0DEFF" d="M6 21.5v-2a5 5 0 0 1 10 0v2Z" />
        <path fill="#D0DEFF" d="M11 6.25a3.5 3.5 0 1 1 0 7a3.5 3.5 0 0 1 0-7Z" />
        <path
          fill="#00B194"
          d="M21.75 17.9l1.5-1.05a.45.45 0 0 1 .75.37v4.31a.45.45 0 0 1-.75.37l-1.5-1.05Z"
        />
        <path
          fill="#2EC9B0"
          d="M15 15.25h4.5a1.75 1.75 0 0 1 1.75 1.75v3.25A1.75 1.75 0 0 1 19.5 22H15a1.75 1.75 0 0 1-1.75-1.75V17A1.75 1.75 0 0 1 15 15.25Z"
        />
      </g>
      <g className="hidden dark:inline">
        <path
          fill="#8EBAFF"
          d="M6.25 2.5h11.5a3.75 3.75 0 0 1 3.75 3.75v11.5a3.75 3.75 0 0 1-3.75 3.75H6.25a3.75 3.75 0 0 1-3.75-3.75V6.25A3.75 3.75 0 0 1 6.25 2.5Z"
        />
        <path fill="#D2E8FF" d="M6 21.5v-2a5 5 0 0 1 10 0v2Z" />
        <path fill="#D2E8FF" d="M11 6.25a3.5 3.5 0 1 1 0 7a3.5 3.5 0 0 1 0-7Z" />
        <path
          fill="#00C2A2"
          d="M21.75 17.9l1.5-1.05a.45.45 0 0 1 .75.37v4.31a.45.45 0 0 1-.75.37l-1.5-1.05Z"
        />
        <path
          fill="#45D8BF"
          d="M15 15.25h4.5a1.75 1.75 0 0 1 1.75 1.75v3.25A1.75 1.75 0 0 1 19.5 22H15a1.75 1.75 0 0 1-1.75-1.75V17A1.75 1.75 0 0 1 15 15.25Z"
        />
      </g>
    </svg>
  );
}
