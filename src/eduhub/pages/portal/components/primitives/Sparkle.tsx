interface Props {
  size?: number;
  color?: string;
  className?: string;
}

/**
 * Decorative four-point sparkle. Used in points-received badges,
 * top-performer toasts, and improvement pills.
 */
export function Sparkle({ size = 12, color = "currentColor", className }: Props) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
    >
      <path
        d="M12 2 L13.6 9.4 L21 11 L13.6 12.6 L12 20 L10.4 12.6 L3 11 L10.4 9.4 Z"
        fill={color}
      />
    </svg>
  );
}
