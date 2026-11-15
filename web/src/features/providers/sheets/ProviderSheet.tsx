import { useCallback, useEffect, useId, useImperativeHandle, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import type { ProviderRecentUsageMap } from '@/components/providers/utils';
import { useNotificationStore } from '@/stores';
import { PROVIDER_DESCRIPTORS } from '../descriptors';
import type { ProviderBrand, ProviderEntryFormInput, ProviderResource } from '../types';
import type { UseProviderWorkbenchResult } from '../useProviderWorkbench';
import { BaseProviderForm } from './forms/BaseProviderForm';
import { ResourceDetailView } from './ResourceDetailView';

type SheetMode = 'detail' | 'create' | 'edit';

export interface ProviderSheetState {
  open: boolean;
  brand: ProviderBrand;
  mode: SheetMode;
  resource: ProviderResource | null;
  /** Run the connectivity test as soon as the edit form opens. */
  autoTest?: boolean;
}

export interface ProviderSheetHandle {
  confirmDiscardIfDirty: () => Promise<boolean>;
}

interface ProviderSheetProps {
  state: ProviderSheetState;
  onClose: () => void;
  onSwitchToEdit: () => void;
  workbench: UseProviderWorkbenchResult;
  onCreated: () => void;
  onUpdated: () => void;
  mutationDisabled?: boolean;
  usageByProvider?: ProviderRecentUsageMap;
  ref?: Ref<ProviderSheetHandle>;
}

export function ProviderSheet({
  state,
  onClose,
  onSwitchToEdit,
  workbench,
  onCreated,
  onUpdated,
  mutationDisabled = false,
  usageByProvider,
  ref,
}: ProviderSheetProps) {
  const { t } = useTranslation();
  const { showConfirmation } = useNotificationStore();
  const formId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  // Reset dirty flag whenever the sheet is closed or the editing target
  // (brand / resource / mode) changes — the child form will re-mount and
  // re-report its own dirty state.
  useEffect(() => {
    setIsDirty(false);
  }, [state.brand, state.mode, state.resource?.id, state.open]);

  const handleDirtyChange = useCallback((dirty: boolean) => {
    setIsDirty(dirty);
  }, []);

  const descriptor = PROVIDER_DESCRIPTORS[state.brand];
  const isEditingForm = state.mode === 'create' || state.mode === 'edit';
  const formMutating = submitting || mutationDisabled;
  const submitDisabled = formMutating || (state.mode === 'edit' && !isDirty);

  const confirmDiscardIfDirty = useCallback((): Promise<boolean> => {
    if (!isEditingForm || !isDirty || submitting) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      showConfirmation({
        title: t('providersPage.unsavedChanges.title'),
        message: t('providersPage.unsavedChanges.message'),
        variant: 'danger',
        confirmText: t('providersPage.unsavedChanges.discard'),
        cancelText: t('providersPage.unsavedChanges.keepEditing'),
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }, [isDirty, isEditingForm, showConfirmation, submitting, t]);

  useImperativeHandle(ref, () => ({ confirmDiscardIfDirty }), [confirmDiscardIfDirty]);

  const handleCancelClick = useCallback(() => {
    void confirmDiscardIfDirty().then((ok) => {
      if (ok) onClose();
    });
  }, [confirmDiscardIfDirty, onClose]);

  const brandName = t(`providersPage.providerNames.${state.brand}`);
  const titleText =
    state.mode === 'create'
      ? t('providersPage.sheet.addTitle', { name: brandName })
      : state.mode === 'edit'
        ? t('providersPage.sheet.editTitle', { name: brandName })
        : t('providersPage.sheet.detailTitle', { name: brandName });
  const resourceName = state.resource
    ? (state.resource.name ?? state.resource.apiKeyPreview ?? state.resource.identifier)
    : null;

  const handleCreate = useCallback(
    async (input: ProviderEntryFormInput) => {
      if (mutationDisabled) return;
      setSubmitting(true);
      try {
        await workbench.createProvider(state.brand, input);
        onCreated();
      } finally {
        setSubmitting(false);
      }
    },
    [mutationDisabled, onCreated, state.brand, workbench]
  );

  const handleUpdate = useCallback(
    async (input: ProviderEntryFormInput) => {
      if (!state.resource || mutationDisabled || !isDirty) return;
      setSubmitting(true);
      try {
        await workbench.updateProvider(state.resource, input);
        onUpdated();
      } finally {
        setSubmitting(false);
      }
    },
    [isDirty, mutationDisabled, onUpdated, state.resource, workbench]
  );

  const renderBody = () => {
    if (state.mode === 'detail') {
      if (!state.resource) {
        return null;
      }
      return <ResourceDetailView resource={state.resource} usageByProvider={usageByProvider} />;
    }
    const formKey = `${state.brand}:${state.resource?.id ?? 'new'}:${state.mode}`;
    return (
      <BaseProviderForm
        key={formKey}
        brand={state.brand}
        resource={state.resource}
        mode={state.mode}
        autoTest={state.mode === 'edit' && state.autoTest === true}
        mutating={formMutating}
        formId={formId}
        onSubmit={state.mode === 'create' ? handleCreate : handleUpdate}
        onDirtyChange={handleDirtyChange}
      />
    );
  };

  const footer =
    state.mode === 'detail' ? (
      <>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('providersPage.actions.close')}
        </Button>
        {state.resource ? (
          <Button variant="primary" size="sm" onClick={onSwitchToEdit} disabled={formMutating}>
            {t('providersPage.actions.edit')}
          </Button>
        ) : null}
      </>
    ) : (
      <>
        <Button variant="ghost" size="sm" onClick={handleCancelClick} disabled={submitting}>
          {t('providersPage.actions.cancel')}
        </Button>
        <Button
          type="submit"
          form={formId}
          variant="primary"
          size="sm"
          loading={submitting}
          disabled={submitDisabled}
        >
          {state.mode === 'create'
            ? t('providersPage.actions.addProvider')
            : t('providersPage.actions.save')}
        </Button>
      </>
    );

  return (
    <Sheet
      open={state.open}
      onClose={onClose}
      size={descriptor.sheetSize}
      title={titleText}
      description={resourceName ?? undefined}
      footer={footer}
      closeDisabled={submitting}
      confirmClose={confirmDiscardIfDirty}
    >
      {renderBody()}
    </Sheet>
  );
}
