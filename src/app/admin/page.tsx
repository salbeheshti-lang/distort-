"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Shield, Users, Mail, Crown, Check, X, Trash2, Send, ExternalLink, AlertCircle, Lock } from "lucide-react";
import { DistortLogo } from "@/components/vpn/distort-logo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";

type User = {
  id: string;
  email: string;
  name: string | null;
  tier: string;
  vipUntil: string | null;
  isAdmin: boolean;
  approvedBy: string | null;
  createdAt: string;
};

type Message = {
  id: string;
  type: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  status: string;
  reply: string | null;
  repliedAt: string | null;
  createdAt: string;
};

export default function AdminPanel() {
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [grantEmail, setGrantEmail] = useState("");
  const [grantDays, setGrantDays] = useState("30");
  const [adminGrantEmail, setAdminGrantEmail] = useState("");
  const [replyText, setReplyText] = useState("");
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  // Check if already logged in (session cookie sent automatically by browser)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    checkExistingSession();
  }, []);

  const checkExistingSession = async () => {
    try {
      const res = await fetch("/api/admin/users");
      if (res.ok) {
        const data = await res.json();
        setAuthed(true);
        setAdminEmail(data.requestedBy || "admin");
        setUsers(data.users || []);
        loadMessages();
      }
    } catch {
      // Not logged in — show login form
    }
  };

  const login = async () => {
    if (!adminEmail || !adminPassword) {
      toast.error("Email and password are required");
      return;
    }
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: adminEmail, password: adminPassword }),
      });
      const data = await res.json();
      if (data.ok) {
        setAuthed(true);
        setAdminPassword(""); // clear password from memory
        toast.success("Login successful", { description: `Welcome, ${data.email}` });
        loadUsers();
        loadMessages();
      } else {
        toast.error(data.error || "Login failed");
      }
    } catch {
      toast.error("Login failed");
    }
  };

  const logout = async () => {
    try {
      await fetch("/api/admin/logout", { method: "POST" });
    } catch {}
    setAuthed(false);
    setUsers([]);
    setMessages([]);
    setAdminEmail("");
    toast.info("Logged out");
  };

  // All admin API calls use cookies automatically (no manual headers needed)
  const loadUsers = async () => {
    try {
      const res = await fetch("/api/admin/users");
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      setUsers(data.users || []);
    } catch { toast.error("Failed to load users"); }
  };

  const loadMessages = async () => {
    try {
      const res = await fetch("/api/admin/messages");
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      setMessages(data.messages || []);
    } catch { toast.error("Failed to load messages"); }
  };

  const grantVIP = async (email: string, days: string) => {
    try {
      const res = await fetch("/api/vip/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, durationDays: days ? Number(days) : null }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success("VIP granted", { description: `${email} — ${days || "permanent"} days` });
        loadUsers();
      } else {
        toast.error(data.error || "Grant failed");
      }
    } catch { toast.error("Grant failed"); }
  };

  const revokeVIP = async (email: string) => {
    try {
      const res = await fetch("/api/vip/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success("VIP revoked", { description: email });
        loadUsers();
      } else {
        toast.error(data.error || "Revoke failed");
      }
    } catch { toast.error("Revoke failed"); }
  };

  const grantAdmin = async (email: string) => {
    try {
      const res = await fetch("/api/admin/grant-admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success("Admin granted", { description: `${email} is now an admin` });
        setAdminGrantEmail("");
        loadUsers();
      } else {
        toast.error(data.error || "Failed");
      }
    } catch { toast.error("Failed"); }
  };

  const replyMessage = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/messages/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: replyText }),
      });
      const data = await res.json();
      if (data.message) {
        toast.success("Reply sent");
        setReplyText("");
        setReplyingTo(null);
        loadMessages();
      }
    } catch { toast.error("Reply failed"); }
  };

  const archiveMessage = async (id: string) => {
    try {
      await fetch(`/api/admin/messages/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      });
      toast.success("Archived");
      loadMessages();
    } catch { toast.error("Archive failed"); }
  };

  const deleteMessage = async (id: string) => {
    try {
      await fetch(`/api/admin/messages/${id}`, { method: "DELETE" });
      toast.success("Deleted");
      loadMessages();
    } catch { toast.error("Delete failed"); }
  };

  // Login screen — email + password (NOT just email)
  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="mesh-bg" />
        <Card className="glass-strong border-[#00f0ff]/20 max-w-md w-full relative z-10">
          <CardContent className="p-8">
            <div className="flex justify-center mb-6">
              <DistortLogo size={64} />
            </div>
            <h1 className="font-display text-2xl font-extrabold text-center text-white mb-2">DISTORT Admin</h1>
            <p className="text-center text-sm text-muted-foreground mb-6">Secure login with password</p>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">Admin Email</Label>
                <Input
                  type="email"
                  placeholder="admin@distort.app"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && login()}
                  className="bg-white/[0.04] border-white/10"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">Password</Label>
                <Input
                  type="password"
                  placeholder="••••••••"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && login()}
                  className="bg-white/[0.04] border-white/10"
                />
              </div>
              <Button onClick={login} className="w-full bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-wider">
                <Lock className="w-4 h-4 mr-2" /> Secure Login
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground/70 text-center mt-4">
              Session expires after 24 hours. Password required.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const pendingMessages = messages.filter(m => m.status === "pending");
  const vipUsers = users.filter(u => u.tier === "vip" || u.isAdmin);
  const adminUsers = users.filter(u => u.isAdmin);

  return (
    <div className="min-h-screen bg-[#050814] text-white p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <DistortLogo size={40} />
          <div>
            <h1 className="font-display text-xl font-extrabold tracking-wider">DISTORT Admin</h1>
            <p className="text-xs text-muted-foreground font-tech uppercase tracking-wider">Logged in as {adminEmail}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={logout} className="border-white/10 text-muted-foreground">
          <Lock className="w-3.5 h-3.5 mr-1" /> Logout
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard icon={<Users className="w-4 h-4" />} label="Total Users" value={users.length} color="#00f0ff" />
        <StatCard icon={<Crown className="w-4 h-4" />} label="VIP Users" value={vipUsers.length} color="#ffb020" />
        <StatCard icon={<Shield className="w-4 h-4" />} label="Admins" value={adminUsers.length} color="#8b5cf6" />
        <StatCard icon={<Mail className="w-4 h-4" />} label="Pending Messages" value={pendingMessages.length} color="#10d9a0" />
      </div>

      <Tabs defaultValue="messages" className="w-full">
        <TabsList className="bg-white/[0.03] border border-white/5 h-10 mb-4">
          <TabsTrigger value="messages" className="data-[state=active]:bg-[#00f0ff]/10 data-[state=active]:text-[#5cf2ff] font-tech uppercase tracking-wider text-xs">
            <Mail className="w-3.5 h-3.5 mr-1.5" /> Messages {pendingMessages.length > 0 && `(${pendingMessages.length})`}
          </TabsTrigger>
          <TabsTrigger value="users" className="data-[state=active]:bg-[#00f0ff]/10 data-[state=active]:text-[#5cf2ff] font-tech uppercase tracking-wider text-xs">
            <Users className="w-3.5 h-3.5 mr-1.5" /> Users ({users.length})
          </TabsTrigger>
          <TabsTrigger value="vip" className="data-[state=active]:bg-[#00f0ff]/10 data-[state=active]:text-[#5cf2ff] font-tech uppercase tracking-wider text-xs">
            <Crown className="w-3.5 h-3.5 mr-1.5" /> VIP Management
          </TabsTrigger>
          <TabsTrigger value="admins" className="data-[state=active]:bg-[#00f0ff]/10 data-[state=active]:text-[#5cf2ff] font-tech uppercase tracking-wider text-xs">
            <Shield className="w-3.5 h-3.5 mr-1.5" /> Admins ({adminUsers.length})
          </TabsTrigger>
        </TabsList>

        {/* Messages Tab */}
        <TabsContent value="messages">
          <Card className="glass border-white/5">
            <CardHeader><CardTitle className="font-display text-sm">Messages & Requests</CardTitle></CardHeader>
            <CardContent className="space-y-3 max-h-[600px] overflow-y-auto">
              {messages.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No messages yet.</p>
              ) : messages.map(msg => (
                <motion.div key={msg.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className={`text-[9px] font-tech uppercase tracking-wider h-4 ${
                          msg.type === "vip_request" ? "border-[#ffb020]/40 text-[#ffb020]" :
                          msg.type === "collaboration" ? "border-[#8b5cf6]/40 text-[#a78bfa]" :
                          msg.type === "bug_report" ? "border-[#ff4d6d]/40 text-[#ff4d6d]" :
                          "border-[#00f0ff]/40 text-[#5cf2ff]"
                        }`}>{msg.type}</Badge>
                        <Badge variant="outline" className={`text-[9px] h-4 ${msg.status === "pending" ? "border-[#ffb020]/40 text-[#ffb020]" : msg.status === "replied" ? "border-[#10d9a0]/40 text-[#10d9a0]" : "border-white/10 text-muted-foreground"}`}>
                          {msg.status}
                        </Badge>
                      </div>
                      <div className="font-semibold text-white text-sm">{msg.subject}</div>
                      <div className="text-xs text-muted-foreground">{msg.name} · {msg.email} · {new Date(msg.createdAt).toLocaleString()}</div>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-3">{msg.message}</p>
                  {msg.reply && (
                    <div className="rounded-lg bg-[#10d9a0]/5 border border-[#10d9a0]/20 p-3 mb-2">
                      <div className="text-[10px] font-tech uppercase tracking-wider text-[#10d9a0] mb-1">Reply</div>
                      <p className="text-sm text-white">{msg.reply}</p>
                    </div>
                  )}
                  <div className="flex gap-2">
                    {msg.status !== "replied" && (
                      <Button size="sm" variant="outline" onClick={() => { setReplyingTo(msg.id); setReplyText(""); }} className="border-[#00f0ff]/30 text-[#5cf2ff] hover:bg-[#00f0ff]/10 text-xs h-7">
                        <Send className="w-3 h-3 mr-1" /> Reply
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => archiveMessage(msg.id)} className="text-xs h-7 text-muted-foreground hover:text-white">
                      Archive
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => deleteMessage(msg.id)} className="text-xs h-7 text-[#ff4d6d] hover:bg-[#ff4d6d]/10">
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                  {replyingTo === msg.id && (
                    <div className="mt-3 space-y-2">
                      <Textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Type your reply..." className="bg-white/[0.04] border-white/10 text-sm" rows={3} />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => replyMessage(msg.id)} className="bg-brand-gradient text-[#02131a] text-xs h-7">
                          <Send className="w-3 h-3 mr-1" /> Send Reply
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setReplyingTo(null)} className="text-xs h-7">Cancel</Button>
                      </div>
                    </div>
                  )}
                </motion.div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Users Tab */}
        <TabsContent value="users">
          <Card className="glass border-white/5">
            <CardHeader><CardTitle className="font-display text-sm">All Users</CardTitle></CardHeader>
            <CardContent className="max-h-[600px] overflow-y-auto">
              {users.map(u => (
                <div key={u.id} className="flex items-center justify-between py-3 border-b border-white/5 last:border-0">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white text-sm">{u.email}</span>
                      {u.isAdmin && <Badge className="bg-[#8b5cf6]/15 border-[#8b5cf6]/40 text-[#a78bfa] text-[9px] h-4 font-tech uppercase">Admin</Badge>}
                      {u.tier === "vip" && <Badge className="bg-[#ffb020]/15 border-[#ffb020]/40 text-[#ffb020] text-[9px] h-4 font-tech uppercase">VIP</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">{u.name || "No name"} · Joined {new Date(u.createdAt).toLocaleDateString()}</div>
                    {u.vipUntil && <div className="text-xs text-[#ffb020]">VIP until: {new Date(u.vipUntil).toLocaleDateString()}</div>}
                  </div>
                  <div className="flex gap-1">
                    {u.tier !== "vip" && !u.isAdmin && (
                      <Button size="sm" variant="outline" onClick={() => grantVIP(u.email, "30")} className="border-[#ffb020]/30 text-[#ffb020] hover:bg-[#ffb020]/10 text-xs h-7">
                        <Crown className="w-3 h-3 mr-1" /> Grant VIP
                      </Button>
                    )}
                    {u.tier === "vip" && (
                      <Button size="sm" variant="ghost" onClick={() => revokeVIP(u.email)} className="text-[#ff4d6d] text-xs h-7">
                        Revoke VIP
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* VIP Management Tab */}
        <TabsContent value="vip">
          <Card className="glass border-white/5 max-w-lg">
            <CardHeader><CardTitle className="font-display text-sm">Grant VIP Access</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">User Email</Label>
                <Input value={grantEmail} onChange={(e) => setGrantEmail(e.target.value)} placeholder="user@email.com" className="bg-white/[0.04] border-white/10" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">Duration (days, empty = permanent)</Label>
                <Input type="number" value={grantDays} onChange={(e) => setGrantDays(e.target.value)} placeholder="30" className="bg-white/[0.04] border-white/10" />
              </div>
              <Button onClick={() => grantVIP(grantEmail, grantDays)} className="w-full bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-wider">
                <Crown className="w-4 h-4 mr-2" /> Grant VIP
              </Button>
              {vipUsers.length > 0 && (
                <div className="mt-4">
                  <div className="text-xs font-tech uppercase tracking-wider text-muted-foreground mb-2">Current VIP Users ({vipUsers.length})</div>
                  {vipUsers.map(u => (
                    <div key={u.id} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                      <span className="text-sm text-white">{u.email}</span>
                      <div className="flex items-center gap-2">
                        {u.vipUntil && <span className="text-xs text-[#ffb020]">until {new Date(u.vipUntil).toLocaleDateString()}</span>}
                        {!u.isAdmin && (
                          <Button size="sm" variant="ghost" onClick={() => revokeVIP(u.email)} className="text-[#ff4d6d] text-xs h-6">Revoke</Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Admins Tab */}
        <TabsContent value="admins">
          <Card className="glass border-white/5 max-w-lg">
            <CardHeader><CardTitle className="font-display text-sm">Manage Admins</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">New Admin Email</Label>
                <Input value={adminGrantEmail} onChange={(e) => setAdminGrantEmail(e.target.value)} placeholder="new-admin@email.com" className="bg-white/[0.04] border-white/10" />
              </div>
              <Button onClick={() => grantAdmin(adminGrantEmail)} className="w-full bg-[#8b5cf6]/20 border border-[#8b5cf6]/40 text-[#a78bfa] hover:bg-[#8b5cf6]/30 font-tech uppercase tracking-wider">
                <Shield className="w-4 h-4 mr-2" /> Grant Admin Access
              </Button>
              <div className="mt-4">
                <div className="text-xs font-tech uppercase tracking-wider text-muted-foreground mb-2">Current Admins ({adminUsers.length})</div>
                {adminUsers.map(u => (
                  <div key={u.id} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                    <div>
                      <span className="text-sm text-white">{u.email}</span>
                      {u.approvedBy && <span className="text-xs text-muted-foreground ml-2">approved by {u.approvedBy.slice(0, 8)}…</span>}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
  return (
    <Card className="glass border-white/5 relative overflow-hidden">
      <div className="absolute inset-0 opacity-20" style={{ background: `radial-gradient(circle at top right, ${color}, transparent 70%)` }} />
      <CardContent className="p-4 relative">
        <div className="flex items-center gap-2 mb-2">
          <span style={{ color }}>{icon}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-tech">{label}</span>
        </div>
        <div className="font-display text-2xl font-bold text-white">{value}</div>
      </CardContent>
    </Card>
  );
}
