import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { AuthFileModelItem } from '@/features/authFiles/constants';
import { isModelExcluded } from '@/features/authFiles/constants';
import styles from './AuthFileModelsModal.module.scss';

export type AuthFileModelsModalProps = {
  open: boolean;
  fileName: string;
  fileType: string;
  loading: boolean;
  error: 'unsupported' | null;
  models: AuthFileModelItem[];
  excluded: Record<string, string[]>;
  onClose: () => void;
  onCopyText: (text: string) => void;
};

export function AuthFileModelsModal(props: AuthFileModelsModalProps) {
  const { t } = useTranslation();
  const { open, fileName, fileType, loading, error, models, excluded, onClose, onCopyText } = props;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('auth_files.models_title', { defaultValue: 'Supported models' }) + ` - ${fileName}`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      {loading ? (
        <div className="hint">
          {t('auth_files.models_loading', { defaultValue: 'Loading model list...' })}
        </div>
      ) : error === 'unsupported' ? (
        <EmptyState
          title={t('auth_files.models_unsupported', {
            defaultValue: 'This feature is not supported in the current version',
          })}
          description={t('auth_files.models_unsupported_desc', {
            defaultValue: 'Please update t3code-proxy to the latest version and try again',
          })}
        />
      ) : models.length === 0 ? (
        <EmptyState
          title={t('auth_files.models_empty', {
            defaultValue: 'No available models for this credential',
          })}
          description={t('auth_files.models_empty_desc', {
            defaultValue:
              'This credential may not be loaded by the server yet, or no models are bound to it.',
          })}
        />
      ) : (
        <div className={styles.list}>
          {models.map((model) => {
            const excludedModel = isModelExcluded(model.id, fileType, excluded);
            return (
              <div
                key={model.id}
                className={`${styles.item} ${excludedModel ? styles.itemExcluded : ''}`}
                onClick={() => {
                  onCopyText(model.id);
                }}
                title={
                  excludedModel
                    ? t('auth_files.models_excluded_hint', {
                        defaultValue: 'This OAuth model is disabled',
                      })
                    : t('common.copy', { defaultValue: 'Copy' })
                }
              >
                <span className={styles.modelId}>{model.id}</span>
                {model.display_name && model.display_name !== model.id && (
                  <span className={styles.modelDisplayName}>{model.display_name}</span>
                )}
                {model.type && <span className={styles.modelType}>{model.type}</span>}
                {excludedModel && (
                  <span className={styles.excludedBadge}>
                    {t('auth_files.models_excluded_badge', { defaultValue: 'Disabled' })}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
