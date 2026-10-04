// Public Supabase browser configuration only.
// Never place a service-role or other secret key in this file.
const SUPABASE_URL = 'https://kbpdapxpvcyysjilmhch.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImticGRhcHhwdmN5eXNqaWxtaGNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyMjI5NzgsImV4cCI6MjEwNTc5ODk3OH0.mO4KJuiUG5Vqcuqln28zZvMP7Rwi_cwvaCvhaQhyIpw';

const supabaseConfig = { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY };
if (typeof window !== 'undefined') {
  window.SUPABASE_URL = SUPABASE_URL;
  window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
  window.SUPABASE_CONFIG = supabaseConfig;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { SUPABASE_URL, SUPABASE_ANON_KEY, supabaseConfig };
