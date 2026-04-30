// Project slug → human-friendly name lookup, used everywhere the
// classifier's slug ("scrollantir") would otherwise leak into the UI
// instead of the curated label ("Scrollantir").
//
// Projects are user-curated and rarely change, so we cache aggressively
// with React Query. The hook returns a `byName(slug)` resolver that
// falls back to the slug when no row matches — better to render
// "scrollantir" than render "—" for an unmigrated chunk.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchProjects, type Project } from './api';

export type ProjectsLookup = {
  byName: (slug: string | null | undefined) => string;
  bySlug: Record<string, Project>;
  isLoading: boolean;
};

export function useProjects(): ProjectsLookup {
  // Effectively-infinite staleTime: projects change rarely (user adds
  // a new one once a week). React Query still re-fetches on explicit
  // invalidate, so a project edit elsewhere can refresh this without
  // a page reload.
  const q = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    staleTime: Infinity,
  });
  return useMemo(() => {
    const bySlug: Record<string, Project> = {};
    for (const p of q.data ?? []) bySlug[p.slug] = p;
    return {
      bySlug,
      isLoading: q.isLoading,
      byName: (slug) => {
        if (slug == null || slug === '') return '';
        return bySlug[slug]?.name ?? slug;
      },
    };
  }, [q.data, q.isLoading]);
}
