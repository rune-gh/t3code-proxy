import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/Button';
import { IconAlertTriangle, IconCopy, IconEye, IconEyeOff } from '@/components/ui/icons';
import { Select, type SelectOption } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import { RESTART_REQUIRED_FIELD_IDS } from '../../constants';
import { configFieldDomId } from '../../searchIndex';
import styles from './Field.module.scss';

/** Pulse class added by useFieldJump to the row a search result points at. */
export const FIELD_HIGHLIGHT_CLASS: string = styles.fieldHighlightActive;

/**
 * Scope root for the `:global(.input/.form-group)` overrides used by block editors.
 * Settings sections mount it; mount it by hand when rendering a block editor elsewhere.
 */
export const FIELDS_ROOT_CLASS: string = styles.fieldsRoot;

const cx = (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' ');

/* ======================================================================
   Setting rows. Toggles, inputs, selects and block editors share one skeleton:
   label, one-line help and errors on the left, the control on a fixed column on
   the right. Rows sit in a SettingList (one bordered list, hairline dividers).
   ====================================================================== */

type SettingCopy = {
  /** Search anchor: the row itself carries the DOM id (see configFieldDomId). */
  fieldId: string;
  label: string;
  description?: ReactNode;
  error?: string;
  /** Inline warning under the help text (for example an exposed bind address). */
  notice?: ReactNode;
};

type SettingIds = { controlId: string; labelId: string; hintId: string; errorId: string };

function useSettingIds(fieldId: string): SettingIds {
  const controlId = useId();
  return {
    controlId,
    labelId: `${controlId}-${fieldId}-label`,
    hintId: `${controlId}-hint`,
    errorId: `${controlId}-error`,
  };
}

function describedBy(ids: SettingIds, description: ReactNode, error?: string) {
  return (
    [error ? ids.errorId : '', description ? ids.hintId : ''].filter(Boolean).join(' ') || undefined
  );
}

type RowKind = 'toggle' | 'input' | 'block';
type ControlSize = 'sm' | 'md' | 'lg';

/** "Restart required" marker shown next to controls the hub reads only at startup. */
export function RestartBadge() {
  const { t } = useTranslation();
  return (
    <Badge tone="warning" outline className={styles.restartBadge}>
      {t('config_management.restart_required')}
    </Badge>
  );
}

function SettingRow({
  fieldId,
  label,
  description,
  error,
  notice,
  ids,
  kind,
  size,
  labelFor,
  control,
}: SettingCopy & {
  ids: SettingIds;
  kind: RowKind;
  size?: ControlSize;
  /** With a single control the label is a <label htmlFor>; block editors only name a group. */
  labelFor?: string;
  control: ReactNode;
}) {
  const restart = RESTART_REQUIRED_FIELD_IDS.has(fieldId);
  return (
    <div
      id={configFieldDomId(fieldId)}
      className={cx(
        styles.row,
        kind === 'toggle' && styles.rowToggle,
        kind === 'block' && styles.rowBlock,
        size && styles[`size_${size}`]
      )}
    >
      <div className={styles.rowCopy}>
        {labelFor ? (
          <label id={ids.labelId} htmlFor={labelFor} className={styles.rowLabel}>
            {label}
          </label>
        ) : (
          <span id={ids.labelId} className={styles.rowLabel}>
            {label}
          </span>
        )}
        {description ? (
          <div id={ids.hintId} className={styles.rowDescription}>
            {description}
          </div>
        ) : null}
        {error ? (
          <div id={ids.errorId} className={styles.rowError} role="alert">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className={styles.rowNotice}>
            <IconAlertTriangle size={14} aria-hidden="true" />
            <span>{notice}</span>
          </div>
        ) : null}
      </div>
      <div className={styles.rowControl}>
        {restart && kind !== 'block' ? <RestartBadge /> : null}
        {control}
      </div>
    </div>
  );
}

export function ToggleSetting({
  checked,
  disabled,
  onChange,
  ...copy
}: Omit<SettingCopy, 'error'> & {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const ids = useSettingIds(copy.fieldId);
  return (
    <SettingRow
      {...copy}
      ids={ids}
      kind="toggle"
      labelFor={ids.controlId}
      control={
        <ToggleSwitch
          id={ids.controlId}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          ariaDescribedBy={describedBy(ids, copy.description)}
        />
      }
    />
  );
}

type NativeInputProps = Pick<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'placeholder' | 'min' | 'max' | 'autoComplete'
>;

export function TextSetting({
  value,
  disabled,
  onChange,
  size = 'md',
  adornment,
  type = 'text',
  placeholder,
  min,
  max,
  autoComplete,
  ...copy
}: SettingCopy &
  NativeInputProps & {
    value: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    /** sm = numbers and durations; md = plain text; lg = URLs, paths, user agents. */
    size?: ControlSize;
    /** Status marker inside the input on the right (for example "Off" when keepalive is 0). */
    adornment?: ReactNode;
  }) {
  const ids = useSettingIds(copy.fieldId);
  return (
    <SettingRow
      {...copy}
      ids={ids}
      kind="input"
      size={size}
      labelFor={ids.controlId}
      control={
        <>
          <input
            id={ids.controlId}
            className={cx('input', adornment ? styles.inputWithAdornment : undefined)}
            type={type}
            value={value}
            placeholder={placeholder}
            min={min}
            max={max}
            autoComplete={autoComplete}
            spellCheck={false}
            disabled={disabled}
            aria-invalid={Boolean(copy.error)}
            aria-describedby={describedBy(ids, copy.description, copy.error)}
            onChange={(event) => onChange(event.target.value)}
          />
          {adornment ? <span className={styles.adornment}>{adornment}</span> : null}
        </>
      }
    />
  );
}

/**
 * Masked text row for keys and tokens: hidden by default, with reveal and copy buttons.
 * The value is only ever rendered as the input value; never in a title, tooltip or log.
 */
export function SecretSetting({
  value,
  disabled,
  onChange,
  placeholder,
  ...copy
}: SettingCopy & {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const ids = useSettingIds(copy.fieldId);
  const [revealed, setRevealed] = useState(false);

  const handleCopy = async () => {
    const copied = await copyToClipboard(value);
    showNotification(
      t(copied ? 'config_management.secret.copied' : 'notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };

  return (
    <SettingRow
      {...copy}
      ids={ids}
      kind="input"
      size="lg"
      labelFor={ids.controlId}
      control={
        <div className={styles.secret}>
          <input
            id={ids.controlId}
            className="input"
            type={revealed ? 'text' : 'password'}
            value={value}
            placeholder={placeholder}
            autoComplete="new-password"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={Boolean(copy.error)}
            aria-describedby={describedBy(ids, copy.description, copy.error)}
            onChange={(event) => onChange(event.target.value)}
          />
          <IconButton
            size="sm"
            aria-label={t(
              revealed ? 'config_management.secret.hide' : 'config_management.secret.reveal'
            )}
            aria-pressed={revealed}
            icon={revealed ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            onClick={() => setRevealed((current) => !current)}
          />
          <IconButton
            size="sm"
            aria-label={t('config_management.secret.copy')}
            icon={<IconCopy size={16} />}
            disabled={!value}
            onClick={() => void handleCopy()}
          />
        </div>
      }
    />
  );
}

export function SelectSetting<T extends string>({
  value,
  options,
  disabled,
  onChange,
  size = 'md',
  ...copy
}: SettingCopy & {
  value: T;
  options: ReadonlyArray<SelectOption & { value: T }>;
  disabled?: boolean;
  onChange: (value: T) => void;
  size?: ControlSize;
}) {
  const ids = useSettingIds(copy.fieldId);
  return (
    <SettingRow
      {...copy}
      ids={ids}
      kind="input"
      size={size}
      labelFor={ids.controlId}
      control={
        <Select
          id={ids.controlId}
          className={styles.selectControl}
          fullWidth
          value={value}
          options={options}
          disabled={disabled}
          ariaLabelledBy={ids.labelId}
          ariaDescribedBy={describedBy(ids, copy.description, copy.error)}
          ariaInvalid={copy.error ? true : undefined}
          onChange={(next) => onChange(next as T)}
        />
      }
    />
  );
}

export type BlockSettingA11y = { describedBy?: string; invalid: boolean };

/**
 * Block editor row (string lists, ICE servers): label and help on top, the editor below
 * across the row. The editor sits in a role="group" named by the label and described by
 * the help and error; pass a function child to receive describedBy for inner controls.
 */
export function BlockSetting({
  children,
  ...copy
}: SettingCopy & {
  children: ReactNode | ((a11y: BlockSettingA11y) => ReactNode);
}) {
  const ids = useSettingIds(copy.fieldId);
  const a11y = {
    describedBy: describedBy(ids, copy.description, copy.error),
    invalid: Boolean(copy.error),
  };
  const restart = RESTART_REQUIRED_FIELD_IDS.has(copy.fieldId);
  return (
    <SettingRow
      {...copy}
      ids={ids}
      kind="block"
      control={
        <div
          role="group"
          aria-labelledby={ids.labelId}
          aria-describedby={a11y.describedBy}
          aria-invalid={a11y.invalid || undefined}
        >
          {restart ? (
            <div className={styles.blockBadge}>
              <RestartBadge />
            </div>
          ) : null}
          {typeof children === 'function' ? children(a11y) : children}
        </div>
      }
    />
  );
}

/** A row for a block that brings its own heading (API keys): anchor and padding only. */
export function SettingCell({ fieldId, children }: { fieldId: string; children: ReactNode }) {
  return (
    <div id={configFieldDomId(fieldId)} className={cx(styles.row, styles.rowCell)}>
      {children}
    </div>
  );
}

/** One bordered list of setting rows, with an optional sub-heading above it. */
export function SettingList({
  title,
  description,
  children,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const Group = title ? 'section' : 'div';
  return (
    <Group className={styles.group}>
      {title ? (
        <header className={styles.groupHeader}>
          <h3 className={styles.groupTitle}>{title}</h3>
          {description ? <p className={styles.groupDescription}>{description}</p> : null}
        </header>
      ) : null}
      <div className={styles.list}>{children}</div>
    </Group>
  );
}

/* ---------- Layout helpers inside block editors ---------- */

export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className={styles.fieldGrid}>{children}</div>;
}

export function FieldStack({ children }: { children: ReactNode }) {
  return <div className={styles.fieldStack}>{children}</div>;
}

// Stable, stateless anchor around a searchable block that is not a setting row
// (payload rule groups). Search jumps target its DOM id and pulse-highlight it.
export function FieldAnchor({ fieldId, children }: { fieldId: string; children: ReactNode }) {
  return (
    <div id={configFieldDomId(fieldId)} className={styles.fieldAnchor}>
      {children}
    </div>
  );
}

/** A standalone help line (for example above an editor inside a SettingCell). */
export function FieldHint({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div id={id} className={styles.fieldHint}>
      {children}
    </div>
  );
}

/** Label-on-top field inside block editors with several controls (payload rules). */
export function FieldShell({
  label,
  labelId,
  htmlFor,
  hint,
  hintId,
  error,
  errorId,
  children,
}: {
  label: string;
  labelId?: string;
  htmlFor?: string;
  hint?: string;
  hintId?: string;
  error?: string;
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.fieldShell}>
      <label id={labelId} htmlFor={htmlFor} className={styles.fieldLabel}>
        {label}
      </label>
      {children}
      {error ? (
        <div id={errorId} className="error-box">
          {error}
        </div>
      ) : null}
      {hint ? (
        <div id={hintId} className={styles.fieldHint}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
