export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      active_requests: {
        Row: {
          completed_count: number;
          created_at: string;
          id: string;
          mode: string;
          status: Database["public"]["Enums"]["request_status"];
          updated_at: string;
          url: string;
          view_count: number;
        };
        Insert: {
          completed_count?: number;
          created_at?: string;
          id?: string;
          mode: string;
          status?: Database["public"]["Enums"]["request_status"];
          updated_at?: string;
          url: string;
          view_count: number;
        };
        Update: {
          completed_count?: number;
          created_at?: string;
          id?: string;
          mode?: string;
          status?: Database["public"]["Enums"]["request_status"];
          updated_at?: string;
          url?: string;
          view_count?: number;
        };
        Relationships: [];
      };
      ai_debug_session: {
        Row: {
          context: string | null;
          created_at: string;
          id: string;
          trace_tag: string;
        };
        Insert: {
          context?: string | null;
          created_at?: string;
          id?: string;
          trace_tag: string;
        };
        Update: {
          context?: string | null;
          created_at?: string;
          id?: string;
          trace_tag?: string;
        };
        Relationships: [];
      };
      cgv_image_analyze: {
        Row: {
          blocked: boolean;
          created_at: string;
          reason: string | null;
          url: string;
        };
        Insert: {
          blocked: boolean;
          created_at?: string;
          reason?: string | null;
          url: string;
        };
        Update: {
          blocked?: boolean;
          created_at?: string;
          reason?: string | null;
          url?: string;
        };
        Relationships: [];
      };
      cgv_mail_report: {
        Row: {
          avoid_holiday: boolean | null;
          created_at: string;
          description: string | null;
          email: string;
          hour_24: number | null;
          min_60: number | null;
        };
        Insert: {
          avoid_holiday?: boolean | null;
          created_at?: string;
          description?: string | null;
          email: string;
          hour_24?: number | null;
          min_60?: number | null;
        };
        Update: {
          avoid_holiday?: boolean | null;
          created_at?: string;
          description?: string | null;
          email?: string;
          hour_24?: number | null;
          min_60?: number | null;
        };
        Relationships: [];
      };
      cgv_movie: {
        Row: {
          anger_count: number | null;
          attraction_keywords: string | null;
          bot_score_0_0_2_count: number | null;
          bot_score_0_2_0_4_count: number | null;
          bot_score_0_4_0_6_count: number | null;
          bot_score_0_6_0_8_count: number | null;
          bot_score_0_8_1_0_count: number | null;
          created_at: string;
          disgust_count: number | null;
          egg_point: number;
          emotion_keywords: string | null;
          emotion_neutral_count: number | null;
          fear_count: number | null;
          happiness_count: number | null;
          midx: string;
          negative_count: number | null;
          neutral_count: number | null;
          positive_count: number | null;
          poster: string | null;
          release_date: string | null;
          review_count: number | null;
          sadness_count: number | null;
          surprise_count: number | null;
          title: string;
          url: string;
          user_comment: string | null;
        };
        Insert: {
          anger_count?: number | null;
          attraction_keywords?: string | null;
          bot_score_0_0_2_count?: number | null;
          bot_score_0_2_0_4_count?: number | null;
          bot_score_0_4_0_6_count?: number | null;
          bot_score_0_6_0_8_count?: number | null;
          bot_score_0_8_1_0_count?: number | null;
          created_at?: string;
          disgust_count?: number | null;
          egg_point?: number;
          emotion_keywords?: string | null;
          emotion_neutral_count?: number | null;
          fear_count?: number | null;
          happiness_count?: number | null;
          midx: string;
          negative_count?: number | null;
          neutral_count?: number | null;
          positive_count?: number | null;
          poster?: string | null;
          release_date?: string | null;
          review_count?: number | null;
          sadness_count?: number | null;
          surprise_count?: number | null;
          title: string;
          url: string;
          user_comment?: string | null;
        };
        Update: {
          anger_count?: number | null;
          attraction_keywords?: string | null;
          bot_score_0_0_2_count?: number | null;
          bot_score_0_2_0_4_count?: number | null;
          bot_score_0_4_0_6_count?: number | null;
          bot_score_0_6_0_8_count?: number | null;
          bot_score_0_8_1_0_count?: number | null;
          created_at?: string;
          disgust_count?: number | null;
          egg_point?: number;
          emotion_keywords?: string | null;
          emotion_neutral_count?: number | null;
          fear_count?: number | null;
          happiness_count?: number | null;
          midx?: string;
          negative_count?: number | null;
          neutral_count?: number | null;
          positive_count?: number | null;
          poster?: string | null;
          release_date?: string | null;
          review_count?: number | null;
          sadness_count?: number | null;
          surprise_count?: number | null;
          title?: string;
          url?: string;
          user_comment?: string | null;
        };
        Relationships: [];
      };
      cgv_movie_egg_point_history: {
        Row: {
          created_at: string;
          egg_point: number;
          id: string;
          midx: string;
        };
        Insert: {
          created_at?: string;
          egg_point: number;
          id?: string;
          midx: string;
        };
        Update: {
          created_at?: string;
          egg_point?: number;
          id?: string;
          midx?: string;
        };
        Relationships: [
          {
            foreignKeyName: "cgv_movie_egg_point_history_midx_fkey";
            columns: ["midx"];
            isOneToOne: false;
            referencedRelation: "cgv_movie";
            referencedColumns: ["midx"];
          },
        ];
      };
      cgv_movie_hourly_stats: {
        Row: {
          anger_count: number | null;
          bot_score_0_0_2_count: number | null;
          bot_score_0_2_0_4_count: number | null;
          bot_score_0_4_0_6_count: number | null;
          bot_score_0_6_0_8_count: number | null;
          bot_score_0_8_1_0_count: number | null;
          disgust_count: number | null;
          emotion_neutral_count: number | null;
          fear_count: number | null;
          happiness_count: number | null;
          hour_start: string;
          id: number;
          midx: string;
          negative_count: number | null;
          neutral_count: number | null;
          positive_count: number | null;
          review_count: number | null;
          sadness_count: number | null;
          surprise_count: number | null;
        };
        Insert: {
          anger_count?: number | null;
          bot_score_0_0_2_count?: number | null;
          bot_score_0_2_0_4_count?: number | null;
          bot_score_0_4_0_6_count?: number | null;
          bot_score_0_6_0_8_count?: number | null;
          bot_score_0_8_1_0_count?: number | null;
          disgust_count?: number | null;
          emotion_neutral_count?: number | null;
          fear_count?: number | null;
          happiness_count?: number | null;
          hour_start: string;
          id?: never;
          midx: string;
          negative_count?: number | null;
          neutral_count?: number | null;
          positive_count?: number | null;
          review_count?: number | null;
          sadness_count?: number | null;
          surprise_count?: number | null;
        };
        Update: {
          anger_count?: number | null;
          bot_score_0_0_2_count?: number | null;
          bot_score_0_2_0_4_count?: number | null;
          bot_score_0_4_0_6_count?: number | null;
          bot_score_0_6_0_8_count?: number | null;
          bot_score_0_8_1_0_count?: number | null;
          disgust_count?: number | null;
          emotion_neutral_count?: number | null;
          fear_count?: number | null;
          happiness_count?: number | null;
          hour_start?: string;
          id?: never;
          midx?: string;
          negative_count?: number | null;
          neutral_count?: number | null;
          positive_count?: number | null;
          review_count?: number | null;
          sadness_count?: number | null;
          surprise_count?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "cgv_movie_hourly_stats";
            columns: ["midx"];
            isOneToOne: false;
            referencedRelation: "cgv_movie";
            referencedColumns: ["midx"];
          },
        ];
      };
      cgv_review: {
        Row: {
          attraction_point: string | null;
          badword_detected: boolean | null;
          bot_score: number | null;
          comment_id: string;
          comment_text: string;
          comment_text_length: number | null;
          created_at: string;
          emotion: string | null;
          emotion_point: string | null;
          evaluation: string | null;
          image_analyzed: boolean | null;
          image_block_reason: string | null;
          image_blocked: boolean | null;
          is_analyzed: boolean | null;
          key_words: string[] | null;
          midx: string;
          negative: number | null;
          neutral: number | null;
          overall: string | null;
          positive: number | null;
          profile_image: string | null;
          quality: string | null;
          review_dangerous_point: number | null;
          review_image: string | null;
          review_memo: string | null;
          review_rank_point: number | null;
          screen_type: string | null;
          spoiler_detected: boolean | null;
          user_id: string;
          user_nickname: string;
          user_regist: string;
        };
        Insert: {
          attraction_point?: string | null;
          badword_detected?: boolean | null;
          bot_score?: number | null;
          comment_id: string;
          comment_text: string;
          comment_text_length?: number | null;
          created_at?: string;
          emotion?: string | null;
          emotion_point?: string | null;
          evaluation?: string | null;
          image_analyzed?: boolean | null;
          image_block_reason?: string | null;
          image_blocked?: boolean | null;
          is_analyzed?: boolean | null;
          key_words?: string[] | null;
          midx: string;
          negative?: number | null;
          neutral?: number | null;
          overall?: string | null;
          positive?: number | null;
          profile_image?: string | null;
          quality?: string | null;
          review_dangerous_point?: number | null;
          review_image?: string | null;
          review_memo?: string | null;
          review_rank_point?: number | null;
          screen_type?: string | null;
          spoiler_detected?: boolean | null;
          user_id: string;
          user_nickname: string;
          user_regist: string;
        };
        Update: {
          attraction_point?: string | null;
          badword_detected?: boolean | null;
          bot_score?: number | null;
          comment_id?: string;
          comment_text?: string;
          comment_text_length?: number | null;
          created_at?: string;
          emotion?: string | null;
          emotion_point?: string | null;
          evaluation?: string | null;
          image_analyzed?: boolean | null;
          image_block_reason?: string | null;
          image_blocked?: boolean | null;
          is_analyzed?: boolean | null;
          key_words?: string[] | null;
          midx?: string;
          negative?: number | null;
          neutral?: number | null;
          overall?: string | null;
          positive?: number | null;
          profile_image?: string | null;
          quality?: string | null;
          review_dangerous_point?: number | null;
          review_image?: string | null;
          review_memo?: string | null;
          review_rank_point?: number | null;
          screen_type?: string | null;
          spoiler_detected?: boolean | null;
          user_id?: string;
          user_nickname?: string;
          user_regist?: string;
        };
        Relationships: [
          {
            foreignKeyName: "cgv_review_comment_midx_fkey";
            columns: ["midx"];
            isOneToOne: false;
            referencedRelation: "cgv_movie";
            referencedColumns: ["midx"];
          },
        ];
      };
      crawl_cache: {
        Row: {
          created_at: string;
          id: string;
          query: string | null;
          result: Json;
          src: string;
          updated_at: string;
          url: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          query?: string | null;
          result: Json;
          src: string;
          updated_at?: string;
          url: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          query?: string | null;
          result?: Json;
          src?: string;
          updated_at?: string;
          url?: string;
        };
        Relationships: [];
      };
      external_service_failure: {
        Row: {
          created_at: string;
          description: string | null;
          service_name: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          service_name: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          service_name?: string;
        };
        Relationships: [];
      };
      llami_api_key: {
        Row: {
          created_at: string | null;
          deleted_at: string | null;
          id: string;
          label: string;
          updated_at: string | null;
          user_id: string;
          user_key: string;
        };
        Insert: {
          created_at?: string | null;
          deleted_at?: string | null;
          id?: string;
          label: string;
          updated_at?: string | null;
          user_id: string;
          user_key: string;
        };
        Update: {
          created_at?: string | null;
          deleted_at?: string | null;
          id?: string;
          label?: string;
          updated_at?: string | null;
          user_id?: string;
          user_key?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_api_key_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_article_blocks: {
        Row: {
          article_id: string;
          block_id: string;
          display_order: number;
        };
        Insert: {
          article_id?: string;
          block_id?: string;
          display_order: number;
        };
        Update: {
          article_id?: string;
          block_id?: string;
          display_order?: number;
        };
        Relationships: [
          {
            foreignKeyName: "article_blocks_article_id_fkey";
            columns: ["article_id"];
            isOneToOne: false;
            referencedRelation: "llami_articles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "article_blocks_block_id_fkey";
            columns: ["block_id"];
            isOneToOne: false;
            referencedRelation: "llami_blocks";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_article_outlines: {
        Row: {
          article_id: string;
          outline_id: string;
        };
        Insert: {
          article_id?: string;
          outline_id?: string;
        };
        Update: {
          article_id?: string;
          outline_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "article_outlines_article_id_fkey";
            columns: ["article_id"];
            isOneToOne: false;
            referencedRelation: "llami_articles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "article_outlines_outline_id_fkey";
            columns: ["outline_id"];
            isOneToOne: false;
            referencedRelation: "llami_outlines";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_articles: {
        Row: {
          created_at: string;
          current_version: number;
          embedding: string | null;
          id: string;
          title: string;
          updated_at: string | null;
        };
        Insert: {
          created_at?: string;
          current_version?: number;
          embedding?: string | null;
          id?: string;
          title: string;
          updated_at?: string | null;
        };
        Update: {
          created_at?: string;
          current_version?: number;
          embedding?: string | null;
          id?: string;
          title?: string;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      llami_authorized_customer: {
        Row: {
          created_at: string;
          id: string;
          is_authorized: boolean | null;
          is_deleted: boolean | null;
          phone_number: string | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_authorized?: boolean | null;
          is_deleted?: boolean | null;
          phone_number?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_authorized?: boolean | null;
          is_deleted?: boolean | null;
          phone_number?: string | null;
        };
        Relationships: [];
      };
      llami_authorized_thread: {
        Row: {
          created_at: string;
          id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          user_id?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_authorized_thread_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "llami_widget_thread";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llami_authorized_thread_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "llami_authorized_customer";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_billing_card: {
        Row: {
          billing_key: string;
          card_company: string;
          card_number: string;
          card_type: string;
          company_code: string | null;
          created_at: string;
          id: string;
          is_deleted: boolean;
          is_primary: boolean;
          is_working: boolean;
          owner_type: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          billing_key: string;
          card_company: string;
          card_number: string;
          card_type: string;
          company_code?: string | null;
          created_at?: string;
          id?: string;
          is_deleted?: boolean;
          is_primary?: boolean;
          is_working?: boolean;
          owner_type: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          billing_key?: string;
          card_company?: string;
          card_number?: string;
          card_type?: string;
          company_code?: string | null;
          created_at?: string;
          id?: string;
          is_deleted?: boolean;
          is_primary?: boolean;
          is_working?: boolean;
          owner_type?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_billing_cards_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_block_outlines: {
        Row: {
          block_id: string;
          outline_id: string;
        };
        Insert: {
          block_id?: string;
          outline_id?: string;
        };
        Update: {
          block_id?: string;
          outline_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "block_outlines_block_id_fkey";
            columns: ["block_id"];
            isOneToOne: false;
            referencedRelation: "llami_blocks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "block_outlines_outline_id_fkey";
            columns: ["outline_id"];
            isOneToOne: false;
            referencedRelation: "llami_outlines";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_blocks: {
        Row: {
          created_at: string;
          current_version: number | null;
          id: string;
          updated_at: string | null;
        };
        Insert: {
          created_at?: string;
          current_version?: number | null;
          id?: string;
          updated_at?: string | null;
        };
        Update: {
          created_at?: string;
          current_version?: number | null;
          id?: string;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      llami_botstore_daily_usage: {
        Row: {
          count: number;
          created_at: string;
          date: string;
          id: string;
          user_id: string;
        };
        Insert: {
          count?: number;
          created_at?: string;
          date: string;
          id?: string;
          user_id: string;
        };
        Update: {
          count?: number;
          created_at?: string;
          date?: string;
          id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_botstore_daily_usage_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_chat_oauth_token: {
        Row: {
          business_id: string;
          business_type: string;
          created_at: string;
          is_deleted: boolean | null;
          token: string;
          updated_at: string | null;
          widget_id: string | null;
        };
        Insert: {
          business_id: string;
          business_type: string;
          created_at?: string;
          is_deleted?: boolean | null;
          token: string;
          updated_at?: string | null;
          widget_id?: string | null;
        };
        Update: {
          business_id?: string;
          business_type?: string;
          created_at?: string;
          is_deleted?: boolean | null;
          token?: string;
          updated_at?: string | null;
          widget_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "llami_chat_oauth_token_widget_id_fkey";
            columns: ["widget_id"];
            isOneToOne: false;
            referencedRelation: "llami_widget";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_customer_otp: {
        Row: {
          created_at: string;
          otp_number: string | null;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          otp_number?: string | null;
          updated_at?: string | null;
          user_id?: string;
        };
        Update: {
          created_at?: string;
          otp_number?: string | null;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_customer_otp_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "llami_authorized_customer";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_default_workspace: {
        Row: {
          created_at: string;
          updated_at: string;
          user_id: string;
          workspace_id: string | null;
        };
        Insert: {
          created_at?: string;
          updated_at?: string;
          user_id: string;
          workspace_id?: string | null;
        };
        Update: {
          created_at?: string;
          updated_at?: string;
          user_id?: string;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "llami_default_workspace_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llami_default_workspace_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "llami_workspace";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_deposit: {
        Row: {
          created_at: string;
          updated_at: string | null;
          user: string;
          workspace_month_pay: number | null;
        };
        Insert: {
          created_at?: string;
          updated_at?: string | null;
          user: string;
          workspace_month_pay?: number | null;
        };
        Update: {
          created_at?: string;
          updated_at?: string | null;
          user?: string;
          workspace_month_pay?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "llami_deposit_user_fkey";
            columns: ["user"];
            isOneToOne: true;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_news: {
        Row: {
          created_at: string;
          id: string;
          is_deleted: boolean | null;
          news_content: string | null;
          news_title: string | null;
          og_image: string | null;
          updated_at: string | null;
          user_id: string | null;
          widget_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_deleted?: boolean | null;
          news_content?: string | null;
          news_title?: string | null;
          og_image?: string | null;
          updated_at?: string | null;
          user_id?: string | null;
          widget_id?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_deleted?: boolean | null;
          news_content?: string | null;
          news_title?: string | null;
          og_image?: string | null;
          updated_at?: string | null;
          user_id?: string | null;
          widget_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_news_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llami_news_widget_id_fkey";
            columns: ["widget_id"];
            isOneToOne: false;
            referencedRelation: "llami_widget";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_notice: {
        Row: {
          content: string | null;
          created_at: string;
          is_show: boolean | null;
          notice_link: string | null;
          notice_type: string | null;
          service_type: string;
          title: string | null;
        };
        Insert: {
          content?: string | null;
          created_at?: string;
          is_show?: boolean | null;
          notice_link?: string | null;
          notice_type?: string | null;
          service_type: string;
          title?: string | null;
        };
        Update: {
          content?: string | null;
          created_at?: string;
          is_show?: boolean | null;
          notice_link?: string | null;
          notice_type?: string | null;
          service_type?: string;
          title?: string | null;
        };
        Relationships: [];
      };
      llami_outlines: {
        Row: {
          created_at: string;
          full_name: string;
          id: string;
          short_name: string;
          updated_at: string | null;
        };
        Insert: {
          created_at: string;
          full_name: string;
          id?: string;
          short_name?: string;
          updated_at?: string | null;
        };
        Update: {
          created_at?: string;
          full_name?: string;
          id?: string;
          short_name?: string;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      llami_payment_workspace: {
        Row: {
          created_at: string;
          updated_at: string;
          user: string;
          workspace_id: string | null;
        };
        Insert: {
          created_at?: string;
          updated_at?: string;
          user: string;
          workspace_id?: string | null;
        };
        Update: {
          created_at?: string;
          updated_at?: string;
          user?: string;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "llami_payment_workspace_user_fkey";
            columns: ["user"];
            isOneToOne: true;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llami_payment_workspace_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "llami_workspace";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_product: {
        Row: {
          amount: number;
          created_at: string;
          currency: string;
          display_name: string;
          id: string;
          is_deleted: boolean;
          name: string;
          quantity: number;
          updated_at: string;
          usage_limit: number;
        };
        Insert: {
          amount: number;
          created_at?: string;
          currency?: string;
          display_name?: string;
          id?: string;
          is_deleted?: boolean;
          name: string;
          quantity?: number;
          updated_at?: string;
          usage_limit: number;
        };
        Update: {
          amount?: number;
          created_at?: string;
          currency?: string;
          display_name?: string;
          id?: string;
          is_deleted?: boolean;
          name?: string;
          quantity?: number;
          updated_at?: string;
          usage_limit?: number;
        };
        Relationships: [];
      };
      llami_search_embeddings: {
        Row: {
          chunk_position: number | null;
          created_at: string;
          embedding: string;
          id: number;
          model: string;
          source: string;
          text: string;
          title: string | null;
          url: string | null;
        };
        Insert: {
          chunk_position?: number | null;
          created_at?: string;
          embedding: string;
          id?: number;
          model: string;
          source: string;
          text: string;
          title?: string | null;
          url?: string | null;
        };
        Update: {
          chunk_position?: number | null;
          created_at?: string;
          embedding?: string;
          id?: number;
          model?: string;
          source?: string;
          text?: string;
          title?: string | null;
          url?: string | null;
        };
        Relationships: [];
      };
      llami_shortlink_aiqr_io: {
        Row: {
          created_at: string;
          id: number;
          widget_id: string;
        };
        Insert: {
          created_at?: string;
          id?: number;
          widget_id: string;
        };
        Update: {
          created_at?: string;
          id?: number;
          widget_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_shortlink_aiqr_io_widget_id_fkey";
            columns: ["widget_id"];
            isOneToOne: true;
            referencedRelation: "llami_widget";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_subscription: {
        Row: {
          billing_card_id: string;
          created_at: string;
          id: string;
          is_deleted: boolean;
          product_id: string;
          subscription_date: number;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          billing_card_id: string;
          created_at?: string;
          id?: string;
          is_deleted: boolean;
          product_id: string;
          subscription_date: number;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          billing_card_id?: string;
          created_at?: string;
          id?: string;
          is_deleted?: boolean;
          product_id?: string;
          subscription_date?: number;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_subscription_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "llami_workspace";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llami_subscriptions_billing_card_id_fkey";
            columns: ["billing_card_id"];
            isOneToOne: false;
            referencedRelation: "llami_billing_card";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llami_subscriptions_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "llami_product";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_vector_file_description: {
        Row: {
          created_at: string;
          file_name: string;
          file_type: string;
          id: number;
          is_deleted: boolean;
          size: number;
          storage_url: string;
          widget_id: string | null;
        };
        Insert: {
          created_at?: string;
          file_name: string;
          file_type: string;
          id?: number;
          is_deleted: boolean;
          size: number;
          storage_url: string;
          widget_id?: string | null;
        };
        Update: {
          created_at?: string;
          file_name?: string;
          file_type?: string;
          id?: number;
          is_deleted?: boolean;
          size?: number;
          storage_url?: string;
          widget_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "llami_vector_file_description_widget_id_fkey";
            columns: ["widget_id"];
            isOneToOne: false;
            referencedRelation: "llami_widget";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_vector_file_embedding: {
        Row: {
          embedding: string;
          file_id: number;
          id: number;
          model: string;
          text: string;
        };
        Insert: {
          embedding: string;
          file_id: number;
          id?: number;
          model: string;
          text: string;
        };
        Update: {
          embedding?: string;
          file_id?: number;
          id?: number;
          model?: string;
          text?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_vector_file_embedding_file_id_fkey";
            columns: ["file_id"];
            isOneToOne: false;
            referencedRelation: "llami_vector_file_description";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_widget: {
        Row: {
          accept_contact: boolean;
          alter_prompt: string | null;
          animation_theme: string | null;
          avatar_src: string | null;
          category: string | null;
          created_at: string;
          description: string | null;
          files: Json | null;
          font_family: string | null;
          icon: string | null;
          id: string;
          is_deleted: boolean | null;
          logo: string | null;
          name: string | null;
          openai_assistant_id: string | null;
          payment_type: string;
          prompt: string | null;
          questions: Json | null;
          store_type: string | null;
          theme: string | null;
          updated_at: string | null;
          vector_store_id: string | null;
          welcome_message: string | null;
          widget_auto_open: boolean | null;
          widget_margin_bottom: number | null;
          widget_margin_right: number | null;
          widget_message_content: string | null;
          widget_message_title: string | null;
          workspace_id: string;
        };
        Insert: {
          accept_contact?: boolean;
          alter_prompt?: string | null;
          animation_theme?: string | null;
          avatar_src?: string | null;
          category?: string | null;
          created_at?: string;
          description?: string | null;
          files?: Json | null;
          font_family?: string | null;
          icon?: string | null;
          id?: string;
          is_deleted?: boolean | null;
          logo?: string | null;
          name?: string | null;
          openai_assistant_id?: string | null;
          payment_type?: string;
          prompt?: string | null;
          questions?: Json | null;
          store_type?: string | null;
          theme?: string | null;
          updated_at?: string | null;
          vector_store_id?: string | null;
          welcome_message?: string | null;
          widget_auto_open?: boolean | null;
          widget_margin_bottom?: number | null;
          widget_margin_right?: number | null;
          widget_message_content?: string | null;
          widget_message_title?: string | null;
          workspace_id: string;
        };
        Update: {
          accept_contact?: boolean;
          alter_prompt?: string | null;
          animation_theme?: string | null;
          avatar_src?: string | null;
          category?: string | null;
          created_at?: string;
          description?: string | null;
          files?: Json | null;
          font_family?: string | null;
          icon?: string | null;
          id?: string;
          is_deleted?: boolean | null;
          logo?: string | null;
          name?: string | null;
          openai_assistant_id?: string | null;
          payment_type?: string;
          prompt?: string | null;
          questions?: Json | null;
          store_type?: string | null;
          theme?: string | null;
          updated_at?: string | null;
          vector_store_id?: string | null;
          welcome_message?: string | null;
          widget_auto_open?: boolean | null;
          widget_margin_bottom?: number | null;
          widget_margin_right?: number | null;
          widget_message_content?: string | null;
          widget_message_title?: string | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_widget_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "llami_workspace";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_widget_botstore_approval: {
        Row: {
          created_at: string;
          id: string;
          review_comment: string;
          status: string;
          updated_at: string;
          widget_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          review_comment?: string;
          status?: string;
          updated_at?: string;
          widget_id?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          review_comment?: string;
          status?: string;
          updated_at?: string;
          widget_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_widget_botstore_approval_widget_id_fkey";
            columns: ["widget_id"];
            isOneToOne: false;
            referencedRelation: "llami_widget";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_widget_payment_log: {
        Row: {
          id: string;
          is_deleted: boolean | null;
          payer_id: string | null;
          payer_phone_number: string | null;
          payment_at: string | null;
          payment_metohd: string | null;
          payment_type: string | null;
          price: number | null;
          service_name: string | null;
          status: string | null;
          workspace_id: string | null;
        };
        Insert: {
          id?: string;
          is_deleted?: boolean | null;
          payer_id?: string | null;
          payer_phone_number?: string | null;
          payment_at?: string | null;
          payment_metohd?: string | null;
          payment_type?: string | null;
          price?: number | null;
          service_name?: string | null;
          status?: string | null;
          workspace_id?: string | null;
        };
        Update: {
          id?: string;
          is_deleted?: boolean | null;
          payer_id?: string | null;
          payer_phone_number?: string | null;
          payment_at?: string | null;
          payment_metohd?: string | null;
          payment_type?: string | null;
          price?: number | null;
          service_name?: string | null;
          status?: string | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "llami_widget_payment_log_payer_id_fkey";
            columns: ["payer_id"];
            isOneToOne: false;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llami_widget_payment_log_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "llami_workspace";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_widget_reference_image: {
        Row: {
          created_at: string;
          description: string;
          embedding: string | null;
          id: string;
          is_deleted: boolean;
          model: string | null;
          src: string;
          updated_at: string;
          widget_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string;
          embedding?: string | null;
          id?: string;
          is_deleted?: boolean;
          model?: string | null;
          src: string;
          updated_at?: string;
          widget_id?: string;
        };
        Update: {
          created_at?: string;
          description?: string;
          embedding?: string | null;
          id?: string;
          is_deleted?: boolean;
          model?: string | null;
          src?: string;
          updated_at?: string;
          widget_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_widget_reference_image_widget_id_fkey";
            columns: ["widget_id"];
            isOneToOne: false;
            referencedRelation: "llami_widget";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_widget_thread: {
        Row: {
          created_at: string;
          id: string;
          is_deleted: boolean | null;
          is_user: boolean | null;
          last_message: string | null;
          message_count: number | null;
          openai_thread_id: string;
          updated_at: string | null;
          widget_id: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_deleted?: boolean | null;
          is_user?: boolean | null;
          last_message?: string | null;
          message_count?: number | null;
          openai_thread_id: string;
          updated_at?: string | null;
          widget_id: string;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_deleted?: boolean | null;
          is_user?: boolean | null;
          last_message?: string | null;
          message_count?: number | null;
          openai_thread_id?: string;
          updated_at?: string | null;
          widget_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_widget_thread_widget_id_fkey";
            columns: ["widget_id"];
            isOneToOne: false;
            referencedRelation: "llami_widget";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "\bllami_widget_thread_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "llami_workspace";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_widget_thread_contact: {
        Row: {
          contact: string;
          created_at: string;
          id: string;
          note: string;
          read_at: string | null;
          thread_id: string;
        };
        Insert: {
          contact?: string;
          created_at?: string;
          id?: string;
          note?: string;
          read_at?: string | null;
          thread_id: string;
        };
        Update: {
          contact?: string;
          created_at?: string;
          id?: string;
          note?: string;
          read_at?: string | null;
          thread_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_widget_thread_contact_thread_id_fkey";
            columns: ["thread_id"];
            isOneToOne: false;
            referencedRelation: "llami_widget_thread";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_widget_thread_message: {
        Row: {
          content: string | null;
          created_at: string;
          embedding: string | null;
          id: number;
          is_user: boolean | null;
          model: string | null;
          thread_id: string | null;
        };
        Insert: {
          content?: string | null;
          created_at?: string;
          embedding?: string | null;
          id?: number;
          is_user?: boolean | null;
          model?: string | null;
          thread_id?: string | null;
        };
        Update: {
          content?: string | null;
          created_at?: string;
          embedding?: string | null;
          id?: number;
          is_user?: boolean | null;
          model?: string | null;
          thread_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "llami_widget_thread_message_thread_id_fkey";
            columns: ["thread_id"];
            isOneToOne: false;
            referencedRelation: "llami_widget_thread";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_widget_thread_prompt: {
        Row: {
          prompt_knowledge: string;
          prompt_settings: string | null;
          prompt_subject: string;
          prompt_system_updated_at: string;
          thread_id: string;
        };
        Insert: {
          prompt_knowledge: string;
          prompt_settings?: string | null;
          prompt_subject: string;
          prompt_system_updated_at: string;
          thread_id: string;
        };
        Update: {
          prompt_knowledge?: string;
          prompt_settings?: string | null;
          prompt_subject?: string;
          prompt_system_updated_at?: string;
          thread_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_widget_thread_prompt_thread_id_fkey";
            columns: ["thread_id"];
            isOneToOne: true;
            referencedRelation: "llami_widget_thread";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_workspace: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          is_default: boolean;
          is_deleted: boolean;
          name: string;
          only_owner_can_add_members: boolean;
          only_owner_can_edit_info: boolean;
          owner: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_default?: boolean;
          is_deleted?: boolean;
          name?: string;
          only_owner_can_add_members?: boolean;
          only_owner_can_edit_info?: boolean;
          owner: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_default?: boolean;
          is_deleted?: boolean;
          name?: string;
          only_owner_can_add_members?: boolean;
          only_owner_can_edit_info?: boolean;
          owner?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_workspace_owner_fkey";
            columns: ["owner"];
            isOneToOne: false;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_workspace_log: {
        Row: {
          code: string | null;
          created_at: string;
          id: number;
          issued_user_id: string | null;
          message: string | null;
          workspace_id: string;
        };
        Insert: {
          code?: string | null;
          created_at?: string;
          id?: number;
          issued_user_id?: string | null;
          message?: string | null;
          workspace_id: string;
        };
        Update: {
          code?: string | null;
          created_at?: string;
          id?: number;
          issued_user_id?: string | null;
          message?: string | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_workspace_log_issued_user_id_fkey";
            columns: ["issued_user_id"];
            isOneToOne: false;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llami_workspace_log_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "llami_workspace";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_workspace_member: {
        Row: {
          created_at: string;
          id: string;
          is_deleted: boolean | null;
          updated_at: string | null;
          user_id: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_deleted?: boolean | null;
          updated_at?: string | null;
          user_id?: string;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_deleted?: boolean | null;
          updated_at?: string | null;
          user_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_workspace_member_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llami_workspace_member_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "llami_workspace";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_workspace_member_invite: {
        Row: {
          created_at: string;
          id: string;
          invited_user_id: string | null;
          is_deleted: boolean | null;
          is_pending: boolean | null;
          is_rejected: boolean | null;
          issued_user_id: string | null;
          workspace_id: string | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          invited_user_id?: string | null;
          is_deleted?: boolean | null;
          is_pending?: boolean | null;
          is_rejected?: boolean | null;
          issued_user_id?: string | null;
          workspace_id?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          invited_user_id?: string | null;
          is_deleted?: boolean | null;
          is_pending?: boolean | null;
          is_rejected?: boolean | null;
          issued_user_id?: string | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "llami_workspace_member_invite_invited_user_id_fkey";
            columns: ["invited_user_id"];
            isOneToOne: false;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llami_workspace_member_invite_issued_user_id_fkey";
            columns: ["issued_user_id"];
            isOneToOne: false;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llami_workspace_member_invite_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "llami_workspace";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_workspace_usage_limit: {
        Row: {
          created_at: string;
          has_usage_alert_sent: boolean | null;
          refresh_usage_count: number | null;
          refreshed_at: string | null;
          special_usage_count: number | null;
          updated_at: string | null;
          usage_alert_count: number | null;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          has_usage_alert_sent?: boolean | null;
          refresh_usage_count?: number | null;
          refreshed_at?: string | null;
          special_usage_count?: number | null;
          updated_at?: string | null;
          usage_alert_count?: number | null;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          has_usage_alert_sent?: boolean | null;
          refresh_usage_count?: number | null;
          refreshed_at?: string | null;
          special_usage_count?: number | null;
          updated_at?: string | null;
          usage_alert_count?: number | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "llami_workspace_usage_limit_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: true;
            referencedRelation: "llami_workspace";
            referencedColumns: ["id"];
          },
        ];
      };
      llami_workspace_usage_log: {
        Row: {
          answer_token_count: number;
          created_at: string;
          id: number;
          question_token_count: number;
          workspace_id: string | null;
        };
        Insert: {
          answer_token_count: number;
          created_at?: string;
          id?: number;
          question_token_count: number;
          workspace_id?: string | null;
        };
        Update: {
          answer_token_count?: number;
          created_at?: string;
          id?: number;
          question_token_count?: number;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "llami_workspace_usage_log_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "llami_workspace";
            referencedColumns: ["id"];
          },
        ];
      };
      llamiwiki_main_list: {
        Row: {
          approved: boolean | null;
          categories: string | null;
          code_name: string | null;
          created_at: string;
          description: string | null;
          email: string | null;
          featured: boolean | null;
          full_name: string | null;
          id: string;
          labels: string | null;
          logo_src: string | null;
          product_website: string | null;
          punch_line: string | null;
          tags: string | null;
          twitter_handle: string | null;
          user_id: string | null;
          view_count: number | null;
        };
        Insert: {
          approved?: boolean | null;
          categories?: string | null;
          code_name?: string | null;
          created_at?: string;
          description?: string | null;
          email?: string | null;
          featured?: boolean | null;
          full_name?: string | null;
          id?: string;
          labels?: string | null;
          logo_src?: string | null;
          product_website?: string | null;
          punch_line?: string | null;
          tags?: string | null;
          twitter_handle?: string | null;
          user_id?: string | null;
          view_count?: number | null;
        };
        Update: {
          approved?: boolean | null;
          categories?: string | null;
          code_name?: string | null;
          created_at?: string;
          description?: string | null;
          email?: string | null;
          featured?: boolean | null;
          full_name?: string | null;
          id?: string;
          labels?: string | null;
          logo_src?: string | null;
          product_website?: string | null;
          punch_line?: string | null;
          tags?: string | null;
          twitter_handle?: string | null;
          user_id?: string | null;
          view_count?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "llamiwiki_main_list_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
        ];
      };
      lse_memo: {
        Row: {
          created_at: string;
          id: string;
          review_id: string;
          text: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          review_id: string;
          text?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          review_id?: string;
          text?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lse_memo_review_id_fkey";
            columns: ["review_id"];
            isOneToOne: false;
            referencedRelation: "lse_review";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lse_memo_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "lse_user";
            referencedColumns: ["id"];
          },
        ];
      };
      lse_product: {
        Row: {
          created_at: string;
          id: string;
          image: string;
          title: string;
          updated_at: string;
          url: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          image: string;
          title: string;
          updated_at?: string;
          url: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          image?: string;
          title?: string;
          updated_at?: string;
          url?: string;
        };
        Relationships: [];
      };
      lse_report: {
        Row: {
          created_at: string;
          curse_detected: boolean;
          id: number;
          review_id: string | null;
          updated_at: string | null;
        };
        Insert: {
          created_at?: string;
          curse_detected?: boolean;
          id?: number;
          review_id?: string | null;
          updated_at?: string | null;
        };
        Update: {
          created_at?: string;
          curse_detected?: boolean;
          id?: number;
          review_id?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "lse_report_review_id_fkey1";
            columns: ["review_id"];
            isOneToOne: false;
            referencedRelation: "lse_review";
            referencedColumns: ["id"];
          },
        ];
      };
      lse_review: {
        Row: {
          content: string | null;
          created_at: string;
          id: string;
          product_id: string;
          updated_at: string;
          writer_id: string | null;
          writer_nickname: string | null;
        };
        Insert: {
          content?: string | null;
          created_at?: string;
          id?: string;
          product_id: string;
          updated_at?: string;
          writer_id?: string | null;
          writer_nickname?: string | null;
        };
        Update: {
          content?: string | null;
          created_at?: string;
          id?: string;
          product_id?: string;
          updated_at?: string;
          writer_id?: string | null;
          writer_nickname?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "lse_review_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "lse_product";
            referencedColumns: ["id"];
          },
        ];
      };
      lse_review_analysis: {
        Row: {
          bot_score: number;
          created_at: string;
          emotion: string;
          id: string;
          negative: number;
          neutral: number;
          overall: string;
          positive: number;
          quality: string;
          review_dangerous_point: number;
          review_id: string;
          review_rank_point: number;
          updated_at: string;
        };
        Insert: {
          bot_score: number;
          created_at?: string;
          emotion: string;
          id?: string;
          negative: number;
          neutral: number;
          overall: string;
          positive: number;
          quality: string;
          review_dangerous_point: number;
          review_id: string;
          review_rank_point: number;
          updated_at?: string;
        };
        Update: {
          bot_score?: number;
          created_at?: string;
          emotion?: string;
          id?: string;
          negative?: number;
          neutral?: number;
          overall?: string;
          positive?: number;
          quality?: string;
          review_dangerous_point?: number;
          review_id?: string;
          review_rank_point?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lse_review_analysis_review_id_fkey";
            columns: ["review_id"];
            isOneToOne: false;
            referencedRelation: "lse_review";
            referencedColumns: ["id"];
          },
        ];
      };
      lse_user: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      lse_user_product: {
        Row: {
          created_at: string;
          product_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          product_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Update: {
          created_at?: string;
          product_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lse_user_product_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "lse_product";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lse_user_product_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "lse_user";
            referencedColumns: ["id"];
          },
        ];
      };
      lunch_groups: {
        Row: {
          choice: string;
          date: string;
          timestamp: string;
          user_id: string;
          username: string;
        };
        Insert: {
          choice: string;
          date: string;
          timestamp: string;
          user_id: string;
          username: string;
        };
        Update: {
          choice?: string;
          date?: string;
          timestamp?: string;
          user_id?: string;
          username?: string;
        };
        Relationships: [];
      };
      phone_otp: {
        Row: {
          created_at: string;
          otp_number: number;
          phone_number: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          otp_number: number;
          phone_number: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          otp_number?: number;
          phone_number?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      proxy_requests: {
        Row: {
          created_at: string;
          error_message: string | null;
          id: string;
          mode: Database["public"]["Enums"]["proxy_mode"];
          request_data: Json;
          response_data: Json | null;
          response_status: number | null;
          status: Database["public"]["Enums"]["request_status"];
          updated_at: string;
          url: string;
          view_count: number;
        };
        Insert: {
          created_at?: string;
          error_message?: string | null;
          id?: string;
          mode: Database["public"]["Enums"]["proxy_mode"];
          request_data?: Json;
          response_data?: Json | null;
          response_status?: number | null;
          status: Database["public"]["Enums"]["request_status"];
          updated_at?: string;
          url: string;
          view_count: number;
        };
        Update: {
          created_at?: string;
          error_message?: string | null;
          id?: string;
          mode?: Database["public"]["Enums"]["proxy_mode"];
          request_data?: Json;
          response_data?: Json | null;
          response_status?: number | null;
          status?: Database["public"]["Enums"]["request_status"];
          updated_at?: string;
          url?: string;
          view_count?: number;
        };
        Relationships: [];
      };
      score_cafe_feed: {
        Row: {
          data: Json | null;
          id: string;
        };
        Insert: {
          data?: Json | null;
          id: string;
        };
        Update: {
          data?: Json | null;
          id?: string;
        };
        Relationships: [];
      };
      scraping_cache: {
        Row: {
          created_at: string;
          result: string;
          url: string;
        };
        Insert: {
          created_at?: string;
          result: string;
          url: string;
        };
        Update: {
          created_at?: string;
          result?: string;
          url?: string;
        };
        Relationships: [];
      };
      system_status: {
        Row: {
          created_at: string;
          id: string;
          is_running: boolean;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_running?: boolean;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_running?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      user: {
        Row: {
          created_at: string;
          email: string | null;
          id: string;
          is_deleted: boolean | null;
          phone_number: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          email?: string | null;
          id?: string;
          is_deleted?: boolean | null;
          phone_number?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          email?: string | null;
          id?: string;
          is_deleted?: boolean | null;
          phone_number?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_profile: {
        Row: {
          created_at: string;
          id: string;
          nick_name: string | null;
          profile_url: string | null;
          updated_at: string | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          nick_name?: string | null;
          profile_url?: string | null;
          updated_at?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          nick_name?: string | null;
          profile_url?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "user_profile_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "user";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      create_article_structure: {
        Args: {
          p_title: string;
          p_structure: Json;
        };
        Returns: Json;
      };
      list: {
        Args: {
          ids: string[];
          member_role: string;
        };
        Returns: {
          id: string;
          name: string;
          description: string;
          owner: string;
          created_at: string;
          updated_at: string;
          is_deleted: boolean;
          only_owner_can_add_members: boolean;
          only_owner_can_edit_info: boolean;
          member_count: number;
          role: string;
        }[];
      };
      llami_search_embeddings_match: {
        Args: {
          query_model: string;
          query_embedding: string;
          match_threshold: number;
          match_count: number;
          text_source: string;
        };
        Returns: {
          url: string;
          text: string;
          model: string;
          source: string;
          created_at: string;
          title: string;
          distance_score: number;
        }[];
      };
      llami_search_embeddings_match_ordered: {
        Args: {
          query_embedding: string;
          query_model: string;
          match_threshold: number;
          match_count: number;
          text_source: string;
          input_url: string;
        };
        Returns: {
          url: string;
          text: string;
          model: string;
          source: string;
          created_at: string;
          title: string;
          distance_score: number;
          chunk_position: number;
        }[];
      };
      llami_vector_file_embeddings_match: {
        Args: {
          query_model: string;
          query_embedding: string;
          match_threshold: number;
          match_count: number;
        };
        Returns: {
          widget_id: string;
          url: string;
          file_name: string;
          file_type: string;
          text: string;
        }[];
      };
      llami_vector_file_embeddings_query: {
        Args: {
          query_embedding: string;
          query_model: string;
          match_threshold: number;
          match_count: number;
          query_widget_id: string;
        };
        Returns: {
          id: number;
          widget_id: string;
          file_name: string;
          file_type: string;
          storage_url: string;
          file_content: string;
          is_deleted: boolean;
          created_at: string;
          size: number;
        }[];
      };
      llami_widget_reference_image_embeddings_match: {
        Args: {
          query_model: string;
          query_embedding: string;
          match_threshold: number;
          match_count: number;
        };
        Returns: {
          created_at: string;
          description: string;
          embedding: string | null;
          id: string;
          is_deleted: boolean;
          model: string | null;
          src: string;
          updated_at: string;
          widget_id: string;
        }[];
      };
      llami_widget_reference_image_embeddings_query: {
        Args: {
          query_embedding: string;
          query_model: string;
          match_threshold: number;
          match_count: number;
          query_widget_id: string;
        };
        Returns: {
          id: string;
          created_at: string;
          updated_at: string;
          src: string;
          description: string;
          widget_id: string;
          is_deleted: boolean;
          embedding: string;
          model: string;
        }[];
      };
      llami_widget_thread_message_embeddings_match:
        | {
            Args: {
              query_model: string;
              query_embedding: string;
              match_threshold: number;
            };
            Returns: {
              content: string | null;
              created_at: string;
              embedding: string | null;
              id: number;
              is_user: boolean | null;
              model: string | null;
              thread_id: string | null;
            }[];
          }
        | {
            Args: {
              query_model: string;
              query_embedding: string;
              match_threshold: number;
              match_count: number;
            };
            Returns: {
              content: string | null;
              created_at: string;
              embedding: string | null;
              id: number;
              is_user: boolean | null;
              model: string | null;
              thread_id: string | null;
            }[];
          };
      llami_widget_thread_message_embeddings_query: {
        Args: {
          query_model: string;
          query_embedding: string;
          query_thread_id: string;
          match_count: number;
          match_threshold: number;
        };
        Returns: {
          id: number;
          created_at: string;
          thread_id: string;
          content: string;
          is_user: boolean;
          embedding: string;
          model: string;
        }[];
      };
      match_articles: {
        Args: {
          query_embedding: string;
          similarity_threshold: number;
          match_count: number;
        };
        Returns: {
          id: string;
          title: string;
          similarity: number;
        }[];
      };
      update_movie_stats: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
      update_total_review_counts: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
    };
    Enums: {
      proxy_mode: "proxy-browser" | "proxy-headless";
      request_status: "COMPLETED" | "FAILED" | "BATCH_FAILED" | "REQUESTED";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicSchema = Database[Extract<keyof Database, "public">];

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (PublicSchema["Tables"] & PublicSchema["Views"])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
        Database[PublicTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
      Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : PublicTableNameOrOptions extends keyof (PublicSchema["Tables"] &
        PublicSchema["Views"])
    ? (PublicSchema["Tables"] &
        PublicSchema["Views"])[PublicTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
    ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
    ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  PublicEnumNameOrOptions extends
    | keyof PublicSchema["Enums"]
    | { schema: keyof Database },
  EnumName extends PublicEnumNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = PublicEnumNameOrOptions extends { schema: keyof Database }
  ? Database[PublicEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : PublicEnumNameOrOptions extends keyof PublicSchema["Enums"]
    ? PublicSchema["Enums"][PublicEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof PublicSchema["CompositeTypes"]
    | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database;
  }
    ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof PublicSchema["CompositeTypes"]
    ? PublicSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;
