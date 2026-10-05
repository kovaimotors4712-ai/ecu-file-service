# V1.5 Customer My Account Improvements Plan

## Architecture & Workflow
```mermaid
graph TD
    A[Customer Account UI] --> B{Order List};
    B --> C[Order Card];
    C --> D[Status Timeline];
    C --> E[Expandable Order Detail];
    C --> F[Download Result (Lazy)];
    A --> G[Notification Panel];
    G --> H[Mark as Read];
```

## Detailed Todo List
- [ ] 1. Order Cards Improvements
  - Update `loadCustomerOrders()` in `auth.js` to render the new order card structure.
  - New properties: `reference` (shortened ID), `vehicle`, `services`, `payment_status`, `status` (processing), `created_at`.
- [ ] 2. Order Status Timeline
  - Create `renderTimeline(orderStatus)` helper to display the process: `Payment` → `File Received` → `File Review` → `Processing` → `Completed`.
- [ ] 3. Result Ready
  - Display "Result Ready" badge if `order_files` contains a `processed` kind file.
  - Button `Download Result` that triggers `auth.js` download helper (lazy fetch).
- [ ] 4. Notifications
  - Update notification panel to show count and list with read state.
  - Retain `markNotificationRead` functionality.
- [ ] 5. Order Detail
  - Add `click` listener to order cards to toggle visibility of order details (payment, processing, note, result).
- [ ] 6. Security & Performance
  - **Security**: Maintain `customer_id` filter on all `rest()` calls. No changes required to RLS, just ensure no data leakage.
  - **Performance**: Files only downloaded when user clicks the "Download" button.
- [ ] 7. UI/UX
  - Responsive desktop/mobile styles. No horizontal overflow.
- [ ] 8. Validation
  - Run required checks as specified: `npm test`, `node --check ...`, `git diff --check`.
