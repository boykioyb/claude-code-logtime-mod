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
  `worklog_create`, đã đăng nhập bằng tài khoản của bạn. Tên server mặc định là `pms`; đổi trong
  Cài đặt → Tài khoản PMS. Cần cho phép sẵn `mcp__<tên server>`, xem [Cấp quyền cho MCP server PMS](#cấp-quyền-cho-mcp-server-pms).
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

## Cấp quyền cho MCP server PMS

Mod gọi tool của MCP server PMS từ panel, không qua một lượt chat. Ở chế độ quyền **auto**, bộ phân loại quyền không
quyết được cho kiểu gọi này nên chặn, và panel báo lỗi kiểu:

```
mcp__pms__worklog_list: The server-side auto mode classifier gave no verdict …
```

Sửa bằng một quy tắc cho phép sẵn trong file cài đặt của Claude Code:

- macOS / Linux: `~/.claude/settings.json`
- Windows: `%USERPROFILE%\.claude\settings.json` (mở nhanh: `notepad "$env:USERPROFILE/.claude/settings.json"` trong PowerShell)

Thêm tên server vào `permissions.allow`. Nếu file chưa có mục `permissions`:

```json
{
  "permissions": {
    "allow": ["mcp__pms"]
  }
}
```

Nếu đã có `"allow": [ … ]` thì chỉ thêm `"mcp__pms"` vào mảng đó (nhớ dấu phẩy giữa các phần tử). Lưu file rồi khởi
động lại Claude.

- `mcp__pms` cho phép **mọi** tool của server `pms`. Muốn hẹp hơn, chỉ cho phép bốn tool mod dùng:
  `"mcp__pms__worklog_list_projects"`, `"mcp__pms__worklog_list_tasks"`, `"mcp__pms__worklog_list"`,
  `"mcp__pms__worklog_create"`.
- Server đặt tên khác `pms` thì đổi tên trong quy tắc cho khớp (`mcp__<tên server>`), và sửa cả trong panel ở
  Cài đặt → Tài khoản PMS.
- Mỗi tài khoản PMS thêm (một MCP server riêng) cần một quy tắc như vậy.

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
