import type { ConfigSectionProps } from '../../types';
import { ApiKeysCardEditor } from '../blocks/ApiKeysCardEditor';
import { SettingCell, SettingList } from '../fields/FieldPrimitives';
import { SettingsSection } from '../SettingsSection';

/** Access: the client API keys other machines use to call the hub. */
export function SectionAccess({ values, disabled, onChange }: ConfigSectionProps) {
  return (
    <SettingsSection id="access">
      <SettingList>
        <SettingCell fieldId="apiKeys">
          <ApiKeysCardEditor
            value={values.apiKeysText}
            disabled={disabled}
            onChange={(apiKeysText) => onChange({ apiKeysText })}
          />
        </SettingCell>
      </SettingList>
    </SettingsSection>
  );
}
