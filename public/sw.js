// Authenticated responses and project files are deliberately never cached.
self.addEventListener('push', event => { const data = event.data?.json() || {}; event.waitUntil(self.registration.showNotification(data.title || 'Workspace', {body:data.body,icon:'/icon.svg',tag:data.chatId,data:{chatId:data.chatId}})); });
self.addEventListener('notificationclick', event => { event.notification.close(); event.waitUntil(clients.openWindow('/?chat='+encodeURIComponent(event.notification.data?.chatId || ''))); });
