import { useId, useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";

/**
 * Wizard field primitives. Every control is square, labeled with
 * .field-label, and wires aria-invalid + aria-describedby when a live
 * error or note is present.
 */

interface Common {
  label: string;
  required?: boolean;
  error?: string;
  note?: ReactNode;
  /** Override the generated id (needed when two steps share a field layout). */
  id?: string;
  onBlur?: () => void;
}

interface FieldHeadProps {
  htmlFor: string;
  label: string;
  required?: boolean;
  /** Optional control rendered on the right of the label line (e.g. Show/Hide). */
  aside?: ReactNode;
}

function FieldHead({ htmlFor, label, required, aside }: FieldHeadProps) {
  if (aside) {
    return (
      <div className="field-head">
        <label className="field-label" htmlFor={htmlFor}>
          {label}
          {required ? <span className="field-req"> *</span> : null}
        </label>
        {aside}
      </div>
    );
  }
  return (
    <label className="field-label" htmlFor={htmlFor}>
      {label}
      {required ? <span className="field-req"> *</span> : null}
    </label>
  );
}

interface TextFieldProps extends Common {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  mono?: boolean;
  type?: "text" | "password" | "time";
}

export function TextField(props: TextFieldProps) {
  const autoId = useId();
  const id = props.id ?? autoId;
  const describedBy = props.error || props.note ? `${id}-desc` : undefined;
  return (
    <div className="field-block">
      <FieldHead htmlFor={id} label={props.label} required={props.required} />
      <input
        id={id}
        className={props.mono ? "field field-mono" : "field"}
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        readOnly={props.readOnly}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={props.onBlur}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
        spellCheck={false}
        autoComplete="off"
      />
      <FieldFoot id={describedBy} error={props.error} note={props.note} />
    </div>
  );
}

interface TextAreaFieldProps extends Common {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}

export function TextAreaField(props: TextAreaFieldProps) {
  const autoId = useId();
  const id = props.id ?? autoId;
  const describedBy = props.error || props.note ? `${id}-desc` : undefined;
  return (
    <div className="field-block">
      <FieldHead htmlFor={id} label={props.label} required={props.required} />
      <textarea
        id={id}
        className="field"
        rows={props.rows ?? 3}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={props.onBlur}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
      />
      <FieldFoot id={describedBy} error={props.error} note={props.note} />
    </div>
  );
}

interface NumberFieldProps extends Common {
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

export function NumberField(props: NumberFieldProps) {
  const autoId = useId();
  const id = props.id ?? autoId;
  const describedBy = props.error || props.note ? `${id}-desc` : undefined;
  return (
    <div className="field-block">
      <FieldHead htmlFor={id} label={props.label} required={props.required} />
      <input
        id={id}
        className="field field-mono"
        type="number"
        inputMode="numeric"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={props.onBlur}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
      />
      <FieldFoot id={describedBy} error={props.error} note={props.note} />
    </div>
  );
}

/** API key with a Show/Hide toggle; always renders as a password by default. */
export function ApiKeyField(
  props: Common & { value: string; onChange: (value: string) => void; placeholder?: string },
) {
  const autoId = useId();
  const id = props.id ?? autoId;
  const [show, setShow] = useState(false);
  const describedBy = props.error || props.note ? `${id}-desc` : undefined;
  const toggle = (
    <button
      type="button"
      className="btn tiny"
      onClick={() => setShow((s) => !s)}
      aria-pressed={show}
      aria-label={show ? "Hide API key" : "Show API key"}
    >
      {show ? <EyeOff size={13} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={13} strokeWidth={1.75} aria-hidden="true" />}
      {show ? "Hide" : "Show"}
    </button>
  );
  return (
    <div className="field-block">
      <FieldHead htmlFor={id} label={props.label} required={props.required} aside={toggle} />
      <input
        id={id}
        className="field field-mono"
        type={show ? "text" : "password"}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={props.onBlur}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
        spellCheck={false}
        autoComplete="off"
      />
      <FieldFoot id={describedBy} error={props.error} note={props.note} />
    </div>
  );
}

function FieldFoot({ id, error, note }: { id: string | undefined; error?: string; note?: ReactNode }) {
  if (!error && !note) return null;
  if (error) {
    return (
      <p id={id} className="field-error">
        {error}
      </p>
    );
  }
  return (
    <p id={id} className="field-note">
      {note}
    </p>
  );
}

// ---- Choices (square radios / checkbox) ----

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

interface ChoiceGroupProps<T extends string> {
  label: string;
  name: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
  /** Columns in the square-button grid; default 3. */
  columns?: 2 | 3;
}

export function ChoiceGroup<T extends string>(props: ChoiceGroupProps<T>) {
  const groupId = useId();
  return (
    <div className="field-block">
      <span className="field-label" id={groupId}>
        {props.label}
      </span>
      <div className={props.columns === 2 ? "choice-row two" : "choice-row"} role="radiogroup" aria-labelledby={groupId}>
        {props.options.map((option) => (
          <label key={option.value} className="choice">
            <input
              type="radio"
              className="radio"
              name={props.name}
              value={option.value}
              checked={props.value === option.value}
              onChange={() => props.onChange(option.value)}
            />
            <span className="choice-label">{option.label}</span>
            {option.hint ? <span className="choice-hint">{option.hint}</span> : null}
          </label>
        ))}
      </div>
    </div>
  );
}

interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function CheckboxField(props: CheckboxFieldProps) {
  const id = useId();
  return (
    <label className="check-line" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        className="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}
