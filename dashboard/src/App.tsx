import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import SummaryPage from './pages/Summary';
import ReportsPage from './pages/Reports';
import TimelinePage from './pages/Timeline';
import SettingsPage from './pages/Settings';
import { useApplyTheme } from './lib/theme';

export default function App() {
  useApplyTheme();
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<SummaryPage />} />
        <Route path="/summary" element={<Navigate to="/" replace />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/timeline" element={<TimelinePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
