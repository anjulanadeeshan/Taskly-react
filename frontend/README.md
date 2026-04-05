# Taskly - Task Manager & Scheduler 

A modern, responsive web application built with React and Tailwind CSS that serves as a comprehensive daily task manager, scheduler, and note-taking workspace.

## 🌟 Features

### 1. **Dashboard Overview** 📊
- Quick statistics on tasks, projects, quick ideas and notes
- Today's task summary with priority breakdown
- monthly shedule view. should be get data from google calender and should show here.

### 2. Daily Schedule 📅
- Visual daily planner with 24-hour timeline
- below is the default weekday (Mon-Fri) schedule:
  schedule should be customized by individual user preferences.
(sample schedule)
  - 6:00 AM – Wake up
  - 6:00-6:30 AM – Freshen up + light exercise
  - 6:30-7:00 AM – Breakfast
  - 7:00-7:30 AM – Review notes / plan the day
  - 7:30-8:00 AM – Travel to university
  - 8:00 AM-5:00 PM – Lectures (with break reminders)
  - 5:00-6:00 PM – Travel back + rest
  - 6:00-7:00 PM – Relax / shower / snack
  - 7:00-9:00 PM – Focused study
  - 9:00-9:30 PM – Dinner
  - 9:30-10:30 PM – Light activities
  - 10:30 PM-6:00 AM – Sleep
- Switch between all 7 days of the week

### 3. **To-Do List** ✓
- Create, mark complete, and delete tasks
- Priority levels: Low, Medium, High
- Due date tracking
- Task tags and descriptions
- Smart sorting (incomplete first, then by priority)

### 4. **Mind Dump** 💭
- Quick note-taking interface
- Pin important notes for quick access
- Rich text note creation
- Organize thoughts and ideas
- Color-coded pinned vs. regular notes

### 6. **Projects** 🎯
- University team software project management
- Track project status (Active, Completed, On-Hold)
- Team member management with roles
- Task management within projects
- Progress tracking for each project
- Visual team member avatars
- kanban type

### 7. **Light/Dark Theme** 🌓
- Toggle between light and dark modes
- Persistent theme preference (saved to localStorage)
- Smooth theme transitions
- Beautiful gradient UI in both modes

### 8. **Responsive Design** 📱
- Desktop-optimized layout
- Mobile-friendly collapsible sidebar
- Tablet-responsive grid layouts
- Touch-friendly interface elements
- Smooth transitions and animations

## Netlify Hosting Setup

This project is ready to deploy on Netlify.

Files added for deployment:
- netlify.toml (build and publish settings + SPA fallback)
- public/_redirects (route fallback for client-side routing)

### Option 1: Deploy from GitHub (recommended)
1. Push this frontend folder to your Git repository.
2. In Netlify, select Add new site -> Import an existing project.
3. Choose your repository and set:
  - Base directory: frontend (only if your repo root contains the frontend folder)
  - Build command: npm run build
  - Publish directory: dist
4. Click Deploy site.

### Option 2: Deploy with Netlify CLI
1. Install CLI: npm install -g netlify-cli
2. Login: netlify login
3. In this frontend folder, run:
  - netlify init
  - netlify deploy --build
4. For production:
  - netlify deploy --prod --build

### Why routing works on refresh
React Router uses client-side routes (for example, /tasks). Netlify must always serve index.html for unknown paths. The redirect rules in netlify.toml and public/_redirects handle this.
