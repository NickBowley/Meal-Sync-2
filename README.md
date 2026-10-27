# Meal Sync & Family Ops — 5-in-1 Household Suite

A unified cross-platform household application combining **Meal Sync** and **Family Logistics ("Family Ops")** with a shared family profile, real-time state, and UK supermarket integration.

## Modules Included

1. **🍲 Meal Sync** (`src/components/MealPlanSection.tsx`, `src/components/GroceryListSection.tsx`, `src/components/HouseholdProfile.tsx`, `src/components/CookModeModal.tsx`)
   - **Store Selector**: Tesco, Sainsbury's, Asda, Morrisons, Waitrose, Aldi, and Lidl with physical entrance-to-exit aisle sequences.
   - **7-Day Dinner Planner**: Interactive Monday–Sunday cards, 1-tap meal swaps, dietary filters (picky eaters, low spice, gluten-free, dairy-free), and max prep time slider (15–45 mins).
   - **Hands-Free Cook Mode**: Step-by-step focus view with Screen Wake Lock API, built-in kitchen countdown timer, and Web Audio chime.
   - **Aisle-Optimized Grocery Run**: Collates ingredients across all 7 meals and sorts them by your chosen supermarket's physical walk path, with direct trolley export and affiliate links.

2. **🚗 Family Logistics ("Family Ops")** (`src/components/logistics/DailyMissionBoard.tsx`, `src/components/logistics/FamilyCalendarHub.tsx`, `src/components/logistics/SchoolActivityVault.tsx`)
   - **Daily Mission & School Run Handoff Board**: Timeline for Morning Drop-Off, After-School Clubs, and Evening Pick-Up with assignee toggles (Mum, Dad, Carpool/Scott, Grandma) and 1-tap status (`Scheduled` → `In Transit` → `Completed`).
   - **Family Shared Calendar & Reminder Hub**: Color-coded events for Nell, Nate, and the whole family, natural-language quick event creation, and Google/Apple Calendar (`.ics`) sync.
   - **School & Activity Vault**: Searchable cards for pickup authorization codes (with privacy masking), emergency contacts, uniform sizes, and term dates.

3. **🛠️ Home Ops & DIY ("Dad Command")** (`src/components/dad/TacticalOpsDashboard.tsx`, `src/components/dad/MaintenanceVault.tsx`, `src/components/dad/EmergencyDeployGroan.tsx`)
   - **Tactical Ops & Household DEFCON Readiness**: Tracks household readiness, tool lending library, utility meter readings, and home/vehicle maintenance schedules.

4. **🎮 Kids Quest** (`src/components/kids/KidsQuestApp.tsx`, `src/components/kids/KidModeHeader.tsx`)
   - **Gamified Chore Quests**: Daily quests, star rewards, streaks, unlockable badges, and a PIN-protected Parental Gate (`src/components/PinPromptModal.tsx`).

5. **💜 Care & Celebrations ("Mum HQ")** (`src/components/mum/MumHqApp.tsx`)
   - **Wardrobe & Size Tracker, Birthday Party Planner & Medical Vault**: Tracks children's growing sizes, party RSVPs/gifts, and NHS/allergy cards.

## Running Locally

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Start the full-stack development server** (Express API + Vite frontend on `http://localhost:3000`):
   ```bash
   npm run dev
   ```
3. **Typecheck & Production Build**:
   ```bash
   npm run lint
   npm run build
   ```
