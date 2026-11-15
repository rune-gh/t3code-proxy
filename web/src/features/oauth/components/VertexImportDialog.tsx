import { useId, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { IconCheckCircle2, IconFileText, IconUpload } from '@/components/ui/icons';
import type { VertexImportState } from '../hooks/useVertexImport';
import { DialogTitle, type DialogHeading } from './OAuthFlowDialog';
import dialogStyles from './OAuthFlowDialog.module.scss';
import styles from './VertexImportDialog.module.scss';

export interface VertexImportDialogProps {
  open: boolean;
  heading: DialogHeading;
  vertex: VertexImportState;
  onPickFile: (file: File | undefined) => void;
  onLocationChange: (value: string) => void;
  onImport: () => void;
  onImportAnother: () => void;
  onViewAuthFiles: () => void;
  onClose: () => void;
}

export function VertexImportDialog({
  open,
  heading,
  vertex,
  onPickFile,
  onLocationChange,
  onImport,
  onImportAnother,
  onViewAuthFiles,
  onClose,
}: VertexImportDialogProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileHintId = useId();
  const [dragging, setDragging] = useState(false);
  const result = vertex.result;

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    onPickFile(event.dataTransfer.files?.[0]);
  };

  const resultRows = result
    ? [
        { key: 'result_project', value: result.projectId },
        { key: 'result_email', value: result.email },
        { key: 'result_location', value: result.location },
        { key: 'result_file', value: result.authFile },
      ].filter((row): row is { key: string; value: string } => Boolean(row.value))
    : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={520}
      className={dialogStyles.dialog}
      title={<DialogTitle {...heading} />}
    >
      {result ? (
        <div className={dialogStyles.result} role="status">
          <IconCheckCircle2 size={24} className={dialogStyles.successMark} aria-hidden="true" />
          <div className={dialogStyles.resultTitle}>{t('vertex_import.result_title')}</div>
          {resultRows.length > 0 && (
            <dl className={styles.facts}>
              {resultRows.map((row) => (
                <div className={styles.fact} key={row.key}>
                  <dt>{t(`vertex_import.${row.key}`)}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className={dialogStyles.resultActions}>
            <Button variant="secondary" onClick={onImportAnother}>
              {t('vertex_import.import_another')}
            </Button>
            <Button variant="primary" onClick={onViewAuthFiles}>
              {t('auth_login.view_auth_files')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={dialogStyles.stack}>
          <p className={dialogStyles.hint}>{t('vertex_import.description')}</p>

          <div className={styles.field}>
            <span className={styles.label}>{t('vertex_import.file_label')}</span>
            <button
              type="button"
              className={styles.dropZone}
              data-dragging={dragging}
              data-filled={Boolean(vertex.file)}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              aria-describedby={fileHintId}
            >
              <span className={styles.dropGlyph} aria-hidden="true">
                {vertex.file ? <IconFileText size={18} /> : <IconUpload size={18} />}
              </span>
              <span className={styles.dropText}>
                <span className={vertex.file ? styles.fileName : styles.dropTitle}>
                  {vertex.file ? vertex.file.name : t('vertex_import.drop_hint')}
                </span>
                <span className={styles.dropHint} id={fileHintId}>
                  {vertex.file ? t('vertex_import.choose_file') : t('vertex_import.file_hint')}
                </span>
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                onPickFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </div>

          <div className={styles.locationField}>
            <Input
              label={t('vertex_import.location_label')}
              hint={t('vertex_import.location_hint')}
              value={vertex.location}
              onChange={(event) => onLocationChange(event.target.value)}
              placeholder={t('vertex_import.location_placeholder')}
              spellCheck={false}
            />
          </div>

          {vertex.error && (
            <div className="error-box" role="alert">
              {vertex.error}
            </div>
          )}

          <div>
            <Button
              variant="primary"
              onClick={onImport}
              disabled={!vertex.file}
              loading={vertex.loading}
            >
              {t('vertex_import.import_button')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
