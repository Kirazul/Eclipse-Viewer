/** The few Eclipse controls the React panes need, over Radix. Styles live in global.css. */
import { Dialog as D, Switch as S } from "radix-ui";
import type { ReactNode } from "react";

export function Toggle(props: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string;
  ariaLabel?: string;
}) {
  return (
    <div className="row-switch" data-tip={props.hint ? props.label : undefined} data-tip-sub={props.hint}>
      <S.Root
        id={props.id}
        className="switch"
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
        data-ignore-arrows-shortcuts="true"
        aria-label={props.ariaLabel}
      >
        <S.Thumb asChild><span /></S.Thumb>
      </S.Root>
      {props.label && <label htmlFor={props.id} style={{ cursor: "pointer" }}>{props.label}</label>}
    </div>
  );
}

export function Modal(props: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  children: ReactNode;
  foot: ReactNode;
}) {
  return (
    <D.Root open={props.open} onOpenChange={props.onOpenChange}>
      <D.Portal>
        <D.Overlay className="dlg-scrim" />
        <D.Content className="dlg" aria-describedby={undefined}>
          <D.Title asChild><h2>{props.title}</h2></D.Title>
          {props.children}
          <div className="dlg-foot">{props.foot}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** A range that fills to its value: the track reads --p. */
export function Range(props: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const p = (props.value - props.min) / (props.max - props.min);
  return (
    <input
      className="range"
      type="range"
      aria-label={props.label}
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value}
      style={{ "--p": p } as React.CSSProperties}
      onChange={(e) => props.onChange(e.target.valueAsNumber)}
      data-ignore-arrows-shortcuts="true"
    />
  );
}
