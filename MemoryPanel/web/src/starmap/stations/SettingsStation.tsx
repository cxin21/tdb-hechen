/**
 * starmap/stations/SettingsStation.tsx — 设置站。
 *
 * 表单本体仍是既有 SettingsPage（实例 / 检索 / 模型 / 应急开关），
 * 这里只换壳。重画表单属于下一阶段，先在单页里保证功能不被切断。
 */
import { Note } from '../theme/ui';
import { SettingsPage } from '@/pages/SettingsPage';

export default function SettingsStation() {
  return (
    <div className="st-body st-body-single">
      <div className="st-main sm-scroll">
        <Note>
          设置表单还是旧组件嵌进来的（字段、校验、提交都原样）。换成星图语汇的表单是下一阶段的事。
        </Note>
        <div className="st-embed">
          <SettingsPage />
        </div>
      </div>
    </div>
  );
}
