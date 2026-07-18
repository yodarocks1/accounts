import { useEffect, useState } from 'react';
import { get, type CompanyInfoWire } from './api';
import { DashboardView } from './views/Dashboard';
import { DocumentsView } from './views/Documents';
import { BankView } from './views/Bank';

/**
 * Hash-routed shell (ADR 0020): #/ dashboard, #/documents[/:id], #/bank.
 * No router dependency — the spike is testing the API boundary, not
 * navigation frameworks.
 */

type Route = { view: 'dashboard' } | { view: 'documents'; id?: string } | { view: 'bank' };

function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter((part) => part.length > 0);
  if (parts[0] === 'documents') {
    return parts[1] !== undefined ? { view: 'documents', id: parts[1] } : { view: 'documents' };
  }
  if (parts[0] === 'bank') return { view: 'bank' };
  return { view: 'dashboard' };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [company, setCompany] = useState<CompanyInfoWire | null>(null);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    void get<CompanyInfoWire>('/company').then(setCompany, () => setCompany(null));
  }, []);

  return (
    <div>
      <h1>{company?.name ?? 'Accounts'}</h1>
      <p className="muted">
        {company !== null ? `Base currency ${company.baseCurrency} · ` : ''}
        the books, read through the same JSON API everything else uses
      </p>
      <nav>
        <a href="#/" className={route.view === 'dashboard' ? 'active' : ''}>Dashboard</a>
        <a href="#/documents" className={route.view === 'documents' ? 'active' : ''}>Documents</a>
        <a href="#/bank" className={route.view === 'bank' ? 'active' : ''}>Bank</a>
      </nav>
      {route.view === 'dashboard' && company !== null && <DashboardView currency={company.baseCurrency} />}
      {route.view === 'documents' && <DocumentsView id={route.id} />}
      {route.view === 'bank' && company !== null && <BankView currency={company.baseCurrency} />}
    </div>
  );
}
