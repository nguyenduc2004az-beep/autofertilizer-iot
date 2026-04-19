# HUONG DAN DEPLOY AUTOFERTILIZER LEN RAILWAY.APP

## Ket qua cuoi cung
Website cong khai tai: https://[ten-du-an].railway.app
Bat ky ai co link deu truy cap duoc (dien thoai, may tinh)

---

## BUOC 1 - Cai Git (neu chua co)

Tai tai: https://git-scm.com/download/win
Cai xong kiem tra: mo PowerShell -> nhap "git --version" -> phai thay "git version x.x.x"

---

## BUOC 2 - Tao tai khoan GitHub (mien phi)

1. Vao https://github.com
2. Click "Sign up" -> Dang ky tai khoan mien phi
3. Xac nhan email

---

## BUOC 3 - Tao GitHub Repository va Push Code

Mo PowerShell, chay tung lenh:

   cd d:\KHOA_LUAN_2026\du_an_web
   git init
   git add .
   git commit -m "AutoFertilizer v2.1 - Deploy to Railway"
   git branch -M main

Tiep theo tao repo tren GitHub:
1. Vao https://github.com -> Click "+" -> "New repository"
2. Ten: autofertilizer-iot
3. Chon "Public"
4. KHONG tick "Add README" (du an da co roi)
5. Click "Create repository"

GitHub se hien thi lenh, chay them:
   git remote add origin https://github.com/[ten-github-cua-ban]/autofertilizer-iot.git
   git push -u origin main

---

## BUOC 4 - Tao tai khoan Railway (mien phi)

1. Vao https://railway.app
2. Click "Start a New Project"
3. Click "Login with GitHub" (dung tai khoan vua tao)
4. Cho phep Railway truy cap GitHub

---

## BUOC 5 - Deploy len Railway

1. Click "New Project"
2. Click "Deploy from GitHub repo"
3. Chon "autofertilizer-iot"
4. Railway tu dong bat dau build (mat 1-2 phut)

---

## BUOC 6 - Cau hinh Bien Moi Truong (Environment Variables)

Sau khi project tao xong:
1. Click vao project -> Click "Variables"
2. Them cac bien sau (click "New Variable"):

   MQTT_URL = mqtt://broker.hivemq.com:1883
   MQTT_TOPIC_PREFIX = autofert_khoa2026

3. Click "Deploy" de ap dung

---

## BUOC 7 - Lay duong link website

1. Click vao project
2. Click "Settings" -> "Domains"
3. Click "Generate Domain"
4. Se nhan duoc link kieu: https://autofertilizer-iot-xxxx.railway.app

---

## BUOC 8 - Cap nhat Firmware ESP32

Mo file: esp32\fertilizer_system\fertilizer_system.ino
Sua 3 dong sau:

   // CU:
   const char* MQTT_SERVER = "192.168.1.xxx";
   const char* TOPIC_CMD    = "fert/cmd";
   const char* TOPIC_STATUS = "fert/status";

   // MOI:
   const char* MQTT_SERVER = "broker.hivemq.com";
   const char* TOPIC_CMD    = "autofert_khoa2026/cmd";
   const char* TOPIC_STATUS = "autofert_khoa2026/status";
   const int   MQTT_PORT    = 1883;

Sau do nap lai firmware vao ESP32.

---

## KIEM TRA

1. Mo link Railway tren dien thoai 4G (KHONG dung WiFi nha)
   -> Neu hien trang dang nhap: THANH CONG
   
2. Dang nhap: admin / admin123

3. Bat ESP32 -> Xem den ket noi tren dashboard
   -> Den xanh "Thiet bi ESP32": THANH CONG

4. Thu lenh Bat dau Pha Tron

---

## LOI THUONG GAP

| Loi | Giai phap |
|-----|-----------|
| Build fail | Xem log tai Railway -> phan Deployments |
| MQTT khong ket noi | Kiem tra bien MQTT_URL da dat dung chua |
| ESP32 khong len | Kiem tra ESP32 co WiFi internet khong, da sua firmware chua |
| Trang trang | Xoa cache trinh duyet (Ctrl+Shift+Delete) |

---

## GHI CHU QUAN TRONG

- Railway mien phi: 500 gio/thang (du de demo luan van)
- Du lieu (lich su pha tron) se mat khi Railway redeploy
  -> Day la binh thuong, chi anh huong den du lieu, khong anh huong code
- Can day code len GitHub moi lan sua -> Railway tu dong cap nhat

