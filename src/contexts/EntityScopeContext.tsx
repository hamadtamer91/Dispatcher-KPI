import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useEntities } from '../hooks/useEntities'
import type { Profile } from '../lib/types'

const STORAGE_KEY = 'ngvs_active_entity_id'

interface EntityScopeValue {
  // The entity every entity-scoped query/write is currently acting under.
  // For super_admin this is switchable (defaults to their own home entity);
  // for everyone else it's always their own entity_id, since RLS locks
  // their data to it anyway.
  activeEntityId: string
  activeEntityName: string
  // Only non-empty for super_admin -- the full switcher list. Empty for
  // other roles, since there's nothing to switch to.
  switchableEntities: { id: string; name: string }[]
  isSuperAdmin: boolean
  setActiveEntityId: (id: string) => void
}

const EntityScopeContext = createContext<EntityScopeValue | null>(null)

export function EntityScopeProvider({ profile, children }: { profile: Profile; children: ReactNode }) {
  const isSuperAdmin = profile.role === 'super_admin'
  const { entities } = useEntities()
  const [selected, setSelected] = useState<string | null>(null)

  // Pick the active entity once entities have loaded: a super_admin's prior
  // choice (if it's still a real, active entity) or else their home entity.
  useEffect(() => {
    if (!isSuperAdmin || entities.length === 0) return
    const stored = localStorage.getItem(STORAGE_KEY)
    const valid = stored && entities.some((e) => e.id === stored) ? stored : profile.entity_id
    setSelected(valid)
  }, [isSuperAdmin, entities, profile.entity_id])

  const setActiveEntityId = (id: string) => {
    if (!isSuperAdmin) return
    setSelected(id)
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      // best-effort only
    }
  }

  const value = useMemo<EntityScopeValue>(() => {
    const activeEntityId = isSuperAdmin ? (selected ?? profile.entity_id) : profile.entity_id
    const activeEntityName = entities.find((e) => e.id === activeEntityId)?.name ?? ''
    return {
      activeEntityId,
      activeEntityName,
      switchableEntities: isSuperAdmin ? entities.map((e) => ({ id: e.id, name: e.name })) : [],
      isSuperAdmin,
      setActiveEntityId,
    }
  }, [isSuperAdmin, selected, profile.entity_id, entities])

  return <EntityScopeContext.Provider value={value}>{children}</EntityScopeContext.Provider>
}

/** The entity every entity-scoped hook reads/writes under right now. Must be
 *  called under EntityScopeProvider (mounted once the user's profile is
 *  loaded). */
export function useEntityScope(): EntityScopeValue {
  const ctx = useContext(EntityScopeContext)
  if (!ctx) throw new Error('useEntityScope must be used within an EntityScopeProvider')
  return ctx
}
