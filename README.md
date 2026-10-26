<img width="756" height="966" alt="kio_2026-10-21_14-32-57_271" src="https://github.com/user-attachments/assets/73a94a5d-45c4-4452-a9f5-73d75d5d0547" />


# log-time — panel log giờ làm cho Claude Code

Mod cho Claude Code (Claude Desktop hoặc terminal): một panel để nhập giờ làm theo ngày, xem theo tuần và tháng,
soạn hoặc sửa ghi chú bằng AI, rồi gửi lên PMS qua các tool MCP `worklog_*` của PMS.

## Có gì

- **Ngày:** các dòng draft / đã gửi / đã khoá, nút −/+ theo bước làm tròn, thêm dòng (dự án, giờ, task, ghi chú),
  chép hôm qua, kéo 7 ngày từ PMS, gửi draft có bước xác nhận (gửi lại không bị trùng).
- **Tuần:** bảng dự án × T2–CN, tổng ngày, số giờ đã gửi, ngày thiếu giờ.
- **Tháng:** danh sách theo tuần (mới nhất trên cùng) hoặc dạng lịch; bấm một ngày để mở.
- **Soạn bằng AI:** đọc hoạt động trong ngày trên máy (lời bạn gõ trong các phiên Claude Code, commit git của bạn),
  model đề xuất các dòng draft; bạn chọn dòng nào thêm. Không bao giờ tự gửi lên PMS.
- **Sửa bằng AI:** viết lại một ghi chú cho gọn, giữ nguyên số liệu và số issue/PR.
- **Gắn issue:** `#123` trong ghi chú được gắn vào task trên PMS, hoặc gửi kèm URL issue GitHub để PMS tự đồng bộ
  (pull request thì bỏ qua).
- **Nhiều tài khoản PMS:** mỗi tài khoản là một MCP server riêng; giờ trong ngày chia cho các tài khoản, không log trùng.

## Cần có

- Claude Code trên **Claude Desktop** hoặc **terminal**. Trên terminal, thanh tiến độ và vạch kẻ vẽ bằng ký tự; app
  mobile chưa dùng được (chưa có ô nhập).
- Một **MCP server của PMS** có các tool `worklog_list_projects`, `worklog_list_tasks`, `worklog_list`,
  `worklog_create`, đã đăng nhập bằng tài khoản của bạn. Chọn server cho từng tài khoản trong Cài đặt → Tài khoản
  PMS (danh sách các server đang kết nối có tool worklog). Không cần quy tắc cho phép nào, xem
  [Quyền gọi MCP server PMS](#quyền-gọi-mcp-server-pms).
- **Node** (cho Soạn bằng AI) và **GitHub CLI** `gh` đã đăng nhập (cho việc gắn issue). Không bắt buộc: thiếu thì
  hai tính năng đó báo lỗi, phần còn lại vẫn chạy.

## Cài

Trong một phiên Claude Code ở terminal:

```
/plugin install log-time --marketplace boykioyb/claude-code-logtime-mod
```

Trả lời `y` để thêm marketplace, rồi chọn phạm vi (user). Hoặc từ shell:

```bash
claude plugin install log-time --marketplace boykioyb/claude-code-logtime-mod
```

Trên Claude Desktop: bấm **+** cạnh ô nhập → **Plugins** → **Add marketplace** với `boykioyb/claude-code-logtime-mod`
→ **Add plugin**.

Mở panel bằng lệnh `/log-time`.

## Quyền gọi MCP server PMS

Từ bản 0.3.8, mod tự cho phép các lệnh PMS **do chính panel gửi**: lấy dự án, lấy task, đọc và tạo worklog, qua
server của một tài khoản đã cài. Bạn không cần thêm quy tắc nào vào `settings.json`, kể cả khi đổi server hay thêm
tài khoản, và ở chế độ quyền **auto** panel cũng không bị chặn.

Phạm vi cho phép giữ hẹp:

- chỉ lệnh gửi từ log-time, không phải lệnh model tự gọi trong cuộc trò chuyện: những lệnh đó vẫn qua kiểm tra quyền
  như thường;
- chỉ bốn tool `worklog_list_projects`, `worklog_list_tasks`, `worklog_list`, `worklog_create`;
- chỉ server mà một tài khoản trong Cài đặt đang dùng;
- không vượt mức tổ chức đặt cho connector (nếu quản trị viên đặt "hỏi" hay "chặn" thì vẫn theo đó).

Bản cũ hơn cần quy tắc `"mcp__<tên server>"` trong `permissions.allow` của `~/.claude/settings.json`
(Windows: `%USERPROFILE%\.claude\settings.json`); quy tắc đó vẫn dùng được nhưng không còn cần.

## Cập nhật

Xem phiên bản đang cài ở **+ → Plugins**, so với `version` trong
[`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) của repo.

**Claude Code ở terminal:**

```bash
claude plugin marketplace update claude-code-logtime-mod
```

```bash
claude plugin update log-time@claude-code-logtime-mod
```

Rồi khởi động lại phiên.

**Claude Desktop:** app giữ một bản clone của repo và **không tự kéo bản mới**; gỡ rồi cài lại vẫn chép từ bản clone cũ.
Cập nhật bản clone bằng git:

1. Thoát hẳn Claude Desktop (cả biểu tượng ở khay hệ thống / thanh menu), để app không giữ file.
2. Kéo bản clone lên `main` mới nhất và xem phiên bản.

   Windows (PowerShell):

   ```powershell
   $m = "$env:USERPROFILE/.claude/plugins/marketplaces/claude-code-logtime-mod"; git -C $m fetch origin; git -C $m reset --hard origin/main; Select-String '"version"' "$m/.claude-plugin/plugin.json"
   ```

   macOS / Linux:

   ```bash
   m=~/.claude/plugins/marketplaces/claude-code-logtime-mod; git -C $m fetch origin && git -C $m reset --hard origin/main && grep '"version"' $m/.claude-plugin/plugin.json
   ```

3. Xoá bản chép của phiên bản cũ trong `~/.claude/plugins/cache/claude-code-logtime-mod/log-time/` (Windows:
   `$env:USERPROFILE/.claude/plugins/cache/claude-code-logtime-mod/log-time/`), ví dụ thư mục `0.2.0`.
4. Mở lại app → **+ → Plugins** → cài hoặc bật **log-time**, kiểm phiên bản mới, rồi mở một phiên mới.

Đường dẫn trong lệnh dùng dấu `/` (PowerShell nhận được): copy từ một số khung chat, `\.` có thể mất dấu `\` và lệnh
báo không tìm thấy thư mục.

## Cấu hình khi cài

| Tuỳ chọn | Mặc định | Dùng khi |
|---|---|---|
| `nodePath` | `node` | `node` không nằm trên PATH của app (ví dụ cài qua nvm): điền đường dẫn đầy đủ (`which node`) |
| `ghPath` | `gh` | tương tự cho GitHub CLI (`which gh`) |

Đặt lại bằng `claude plugin configure log-time@claude-code-logtime-mod`. Panel → Cài đặt → **Môi trường** cho biết
Node và `gh` có chạy được không.

## Dữ liệu và quyền riêng tư

- Dữ liệu log nằm trên máy: `~/.local/share/log-time/` (một file JSON mỗi tháng, mỗi tài khoản).
- Mod không giữ token nào; mọi lệnh tới PMS đi qua MCP server bạn đã cấu hình.
- Soạn bằng AI đọc `~/.claude/projects/*/*.jsonl` và `git log` ngay trên máy, chỉ gửi bản tóm tắt cho model.

## Ghi công

Icon từ [Lucide](https://lucide.dev) (giấy phép ISC), nhúng trong `hooks/icons.ts`.
