'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface UserOption {
  id: string;
  name: string;
  email: string;
}

interface UserViewContextValue {
  viewAsId: string | null;        // null = view own data
  viewAsUser: UserOption | null;
  setViewAs: (user: UserOption | null) => void;
  viewAsParam: string;            // query string to append: ?viewAs=xxx or ''
}

const UserViewContext = createContext<UserViewContextValue>({
  viewAsId: null,
  viewAsUser: null,
  setViewAs: () => {},
  viewAsParam: '',
});

export function UserViewProvider({ children, currentUserId }: { children: ReactNode; currentUserId: string }) {
  const [viewAsUser, setViewAsUser] = useState<UserOption | null>(null);

  // Restore from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('viewAsUser');
      if (saved) {
        const parsed = JSON.parse(saved) as UserOption;
        if (parsed.id !== currentUserId) setViewAsUser(parsed);
      }
    } catch {}
  }, [currentUserId]);

  const setViewAs = (user: UserOption | null) => {
    setViewAsUser(user);
    if (user && user.id !== currentUserId) {
      localStorage.setItem('viewAsUser', JSON.stringify(user));
    } else {
      localStorage.removeItem('viewAsUser');
    }
  };

  const viewAsId = viewAsUser && viewAsUser.id !== currentUserId ? viewAsUser.id : null;

  return (
    <UserViewContext.Provider value={{
      viewAsId,
      viewAsUser: viewAsId ? viewAsUser : null,
      setViewAs,
      viewAsParam: viewAsId ? `viewAs=${viewAsId}` : '',
    }}>
      {children}
    </UserViewContext.Provider>
  );
}

export function useUserView() {
  return useContext(UserViewContext);
}
